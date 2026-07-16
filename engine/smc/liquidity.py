"""Liquidity pools and sweeps (port of liquidity.ts).

Liquidity pools: where resting stop orders cluster. Equal highs accumulate
buy-side liquidity just above them; equal lows accumulate sell-side liquidity
just below. Each EQH/EQL cluster maps to one pool at the cluster's extreme.

This module only *derives* pools from the structure output — it never
re-detects equality and adds no state of its own, so it inherits the structure
engine's determinism and replay safety. See EDR 0002/0003.
"""

import math
from dataclasses import dataclass
from typing import Literal

from smc.structure import EQUAL_LEVEL_TOLERANCE, EqualLevel, MarketStructure
from smc.types import Candle

# Buy-side liquidity rests above equal highs; sell-side below equal lows.
LiquiditySide = Literal["bsl", "ssl"]
LiquidityTier = Literal["Strong", "Moderate", "Weak"]

# Component weights. Touches dominate because stacked stops are the essence of
# a pool; recency outweighs tightness because an old shelf, however clean, has
# had its orders repositioned; tightness refines between the two.
LIQUIDITY_WEIGHTS = {"touches": 0.4, "tightness": 0.25, "recency": 0.35}


@dataclass(slots=True)
class LiquidityPoolComponents:
    """Explainable inputs behind a pool's confidence, each normalized to [0, 1]."""

    # More equal touches = more stops accumulated. 2 -> 0.5, 3 -> 0.85, 4+ -> 1.
    touches: float
    # How tightly the cluster's swings match: 1 = tick-identical, 0 = tolerance edge.
    tightness: float
    # How recent the cluster's last touch is within the swing sequence.
    recency: float


@dataclass(slots=True)
class LiquidityPool:
    side: LiquiditySide
    # The liquidity line — the cluster's extreme, where the resting stops sit.
    price: float
    # The EQH/EQL cluster this pool is derived from.
    cluster: EqualLevel
    # True while no later swing has traded beyond the level (structural
    # bookkeeping only — sweep vs breakout is a candle-level question).
    intact: bool
    # 0-100, the weighted blend of components (see LIQUIDITY_WEIGHTS).
    confidence: int
    # Qualitative band over confidence (see EDR 0002); derived, not independent.
    tier: LiquidityTier
    components: LiquidityPoolComponents


@dataclass(slots=True)
class LiquiditySweep:
    """A stop hunt: a closed candle's wick traded through a pool's level but
    closed back on the near side — a raid, not an acceptance."""

    side: LiquiditySide
    # The pool that was swept — the same object exposed in the pools list.
    pool: LiquidityPool
    # Bar time of the closed candle that performed the sweep.
    time: int
    # The wick extreme: how deep into the stops the raid reached.
    extreme: float
    # The sweep candle's close, back on the near side of the level.
    close: float
    # Wick distance beyond the level, as a fraction of the level.
    penetration: float


def _confidence_tier(confidence: int) -> LiquidityTier:
    return "Strong" if confidence >= 70 else "Moderate" if confidence >= 45 else "Weak"


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _touches_score(touches: int) -> float:
    """2 touches -> 0.5, 3 -> 0.85, 4+ -> 1: a double top is the baseline, not the ceiling."""
    return _clamp01(0.5 + (touches - 2) * 0.35)


def _tightness_score(cluster: EqualLevel, equal_tolerance: float) -> float:
    """1 when every member printed the identical price, falling linearly to 0 as
    the span approaches the widest the equality tolerance allows (2x one side)."""
    if equal_tolerance <= 0:
        return 1.0
    prices = [s.price for s in cluster.swings]
    anchor = cluster.swings[0].price
    span = max(prices) - min(prices)
    return _clamp01(1 - span / anchor / (2 * equal_tolerance))


def _recency_score(last_member_index: int, swing_count: int) -> float:
    """Position of the cluster's last touch within the swing sequence — swing-
    indexed so the score is timeframe-agnostic and replay-safe."""
    if swing_count <= 0:
        return 0.0
    return _clamp01((last_member_index + 1) / swing_count)


def _js_round(value: float) -> int:
    """JS Math.round — half always rounds up (toward +inf), unlike Python's banker's."""
    return math.floor(value + 0.5)


def _pool_from(
    cluster: EqualLevel,
    structure: MarketStructure,
    equal_tolerance: float,
) -> LiquidityPool:
    side: LiquiditySide = "bsl" if cluster.kind == "eqh" else "ssl"
    last_member = cluster.swings[-1]
    # Cluster members are the same objects the structure's swings list holds,
    # so identity lookup is exact; the time+kind fallback only guards against a
    # reconstructed (deserialized) structure.
    last_index = next(
        (i for i, s in enumerate(structure.swings) if s is last_member),
        -1,
    )
    if last_index == -1:
        last_index = next(
            (
                i
                for i, s in enumerate(structure.swings)
                if s.time == last_member.time and s.kind == last_member.kind
            ),
            -1,
        )

    intact = True
    for swing in structure.swings[last_index + 1 :]:
        if swing.kind != last_member.kind:
            continue
        if swing.price > cluster.price if side == "bsl" else swing.price < cluster.price:
            intact = False
            break

    components = LiquidityPoolComponents(
        touches=_touches_score(len(cluster.swings)),
        tightness=_tightness_score(cluster, equal_tolerance),
        recency=_recency_score(last_index, len(structure.swings)),
    )
    confidence = _js_round(
        100
        * (
            LIQUIDITY_WEIGHTS["touches"] * components.touches
            + LIQUIDITY_WEIGHTS["tightness"] * components.tightness
            + LIQUIDITY_WEIGHTS["recency"] * components.recency
        )
    )

    return LiquidityPool(
        side=side,
        price=cluster.price,
        cluster=cluster,
        intact=intact,
        confidence=confidence,
        tier=_confidence_tier(confidence),
        components=components,
    )


def compute_liquidity_pools(
    structure: MarketStructure,
    equal_tolerance: float = EQUAL_LEVEL_TOLERANCE,
) -> list[LiquidityPool]:
    """Derive liquidity pools from the structure's EQH/EQL clusters.

    Pass the same equal_tolerance the structure was computed with — it
    calibrates the tightness score's scale. Pools are returned strongest-first
    (confidence desc, price asc, then bsl before ssl); spent pools are included
    with intact=False for callers that want the history.
    """
    pools = [
        _pool_from(c, structure, equal_tolerance)
        for c in [*structure.equal_highs, *structure.equal_lows]
    ]
    return sorted(pools, key=lambda p: (-p.confidence, p.price, 0 if p.side == "bsl" else 1))


def detect_liquidity_sweeps(
    pools: list[LiquidityPool], candles: list[Candle]
) -> list[LiquiditySweep]:
    """Detect sweeps of the given pools on *closed* candles.

    For each pool, the first candle after the pool's completing touch whose
    wick penetrates the level decides the outcome once and for all: close back
    on the near side is a sweep; close beyond is a breakout (no event) — either
    way the stops are spent, so a pool yields at most one sweep. First-touch-
    decides makes the result append-only under new candles.

    Candle-level truth deliberately outranks swing-level bookkeeping: a wick
    that runs the stops but never confirms as a pivot leaves the pool intact by
    swing accounting while this detector still reports the sweep (EDR 0002/0003).
    """
    sweeps: list[LiquiditySweep] = []
    for pool in pools:
        last_touch = pool.cluster.swings[-1]
        for candle in candles:
            # The pool exists only once its completing touch has printed; the
            # touch bar itself (whose extreme *is* the level) can't sweep it.
            if candle.time <= last_touch.time:
                continue
            penetrated = candle.high > pool.price if pool.side == "bsl" else candle.low < pool.price
            if not penetrated:
                continue
            rejected = (
                candle.close <= pool.price if pool.side == "bsl" else candle.close >= pool.price
            )
            if rejected:
                extreme = candle.high if pool.side == "bsl" else candle.low
                sweeps.append(
                    LiquiditySweep(
                        side=pool.side,
                        pool=pool,
                        time=candle.time,
                        extreme=extreme,
                        close=candle.close,
                        penetration=abs(extreme - pool.price) / pool.price,
                    )
                )
            break
    return sorted(sweeps, key=lambda s: (s.time, s.pool.price, 0 if s.side == "bsl" else 1))
