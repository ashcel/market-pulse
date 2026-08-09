"""RALLY WATCHER — live 15-minute momentum scanner with target + liquidity.

A LIVE-WATCH discovery read, not a persisted pattern and not a trade signal:
it flags assets that have been rallying over the last ~15 minutes (three
closed 5-minute bars) on confirming volume, and answers Dee's complaint about
`/discover` being "kurang informatif" (not informative enough) by naming
*where the move is heading* and *what sits above/below*:

1. `targets.smcPool` (PRIMARY) — the nearest intact buy-side-liquidity pool
   above current price, from the same SMC structure/liquidity engine
   `evaluate_signal` uses (`smc.structure` -> `smc.liquidity`).
2. `targets.resistance` (SECONDARY) — the nearer of the nearest swing high
   above, or a measured-move projection off the rally's own base.
3. `targets.liquidation` — an ESTIMATED average-leverage liquidation cluster
   above price (fuel for continuation), derived from a VWAP entry proxy, not
   from any actual position data. Always label it as an estimate.

Deliberately outside the trading engine, like `spike.py`/`reaccumulation.py`:
no `ENGINE_VERSION`, no decision/trigger semantics, its own
`RALLY_WATCHER_VERSION` provenance. Nothing here is persisted — the API layer
holds only a short-lived in-process cache, never a `signal_events` row.

Replay-safety is still the contract: `evaluate_rally(candles, oi, funding,
index, symbol)` reads only `candles[: index + 1]` (and `oi` samples
timestamped at or before that bar's time). Evaluating the full series at
index `i` and evaluating `candles[: i + 1]` at index `-1` must be
byte-identical — the test suite pins this directly. `funding` is a bare
scalar (the live current funding rate) rather than a time series: it is
carried through to the explanation/detail text only and never gates or
scores the read, so it costs the replay-safety proof nothing.

## Liquidation-estimate formulas

Given an assumed average entry leverage `L` (`AVG_LEVERAGE`), a maintenance
margin rate `MMR`, and a VWAP entry proxy `E` (the volume-weighted average
close of the last `ENTRY_VWAP_BARS` bars — the average recent entry, not any
real trader's actual entry):

    long_liq  = E * (1 - 1/L) / (1 - MMR)
    short_liq = E * (1 + 1/L) / (1 + MMR)

For an up-rally the interesting level is `short_liq` (short positions get
liquidated on the way up, adding forced-buy fuel to the move) — it is the
`targets.liquidation` entry. `long_liq` sits below price as context only, in
`liquidity["longLiq"]`. Both are estimates off an assumed average leverage,
never a fact about any real position — every label and detail string says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from smc.analysis import compute_pivots
from smc.liquidity import LiquidityPool, compute_liquidity_pools
from smc.reaccumulation import OiPoint
from smc.structure import compute_market_structure
from smc.types import Candle

Direction = Literal["long"]
Verdict = Literal["greenlight", "watch", "skip"]

# Provenance stamp — this module's own version, not ENGINE_VERSION.
# 1.0.1: added the human-language verdict/verdict_reason fields — a display
# classification of the already-computed read, not a new gate on `evaluate_rally`
# firing, but still a behavior change to the shape emitted, hence the bump.
RALLY_WATCHER_VERSION = "1.0.1"

# ── window sizing ────────────────────────────────────────────────────────────
# 5-minute bars; 8h of context is enough for pivots/structure without reaching
# into an unrelated earlier session.
LOOKBACK_BARS = 96
# The rally window: the last 3 closed 5m bars, ~15 minutes.
RALLY_WINDOW_BARS = 3
# Trailing bars (immediately before the rally window) the volume multiple is
# measured against — 24 bars of 5m = 2h of "normal" tape.
VOLUME_TRAILING_BARS = 24
# VWAP entry proxy window for the liquidation estimate — last 24x5m = 2h.
ENTRY_VWAP_BARS = 24
# Bars needed: the rally-window baseline bar + the trailing volume window,
# with a little slack so pivots always have room.
MIN_BARS_REQUIRED = RALLY_WINDOW_BARS + VOLUME_TRAILING_BARS + 2

# ── rally gates ──────────────────────────────────────────────────────────────
RALLY_MIN_GAIN_PCT = 1.0
RALLY_VOLUME_MULT = 1.3
# A rally this large is chasing territory, not an entry setup — still reads,
# but honestly labeled `extended=True` with the score capped (see below).
RALLY_EXTENDED_PCT = 8.0
EXTENDED_SCORE_CAP = 55.0
# Distance (%) within which an intact BSL pool above earns the momentum-score
# liquidity-alignment bonus — the target and the rally agree.
RALLY_TARGET_BONUS_PCT = 3.0
# Volume multiple beyond which extra volume stops adding momentum-score credit.
VOLUME_SCORE_CAP_MULT = 3.0

# ── momentum score weights ──────────────────────────────────────────────────
# Sum to 1.0. gain rewards the size of the move (capped at the extended
# threshold so a bigger-but-already-blown-out move doesn't score higher);
# volume rewards confirming participation; proximity rewards a decisive close
# near the window high (the fade guard already requires >= the midpoint);
# the liquidity bonus rewards a rally that has real resting stops to chase.
WEIGHT_GAIN = 0.35
WEIGHT_VOLUME = 0.25
WEIGHT_PROXIMITY = 0.20
WEIGHT_LIQUIDITY_BONUS = 0.20

# ── liquidation-estimate model ──────────────────────────────────────────────
AVG_LEVERAGE = 10.0
MMR = 0.005

# ── verdict thresholds ───────────────────────────────────────────────────────
# `verdict` is a pure, deterministic classification of an already-fired read —
# it never gates `evaluate_rally` itself (a skip verdict still returns a full
# RallyRead, chips and all; it just tells Dee not to chase it). Rules, in
# priority order:
#
#   SKIP       — extended (already blew out, chasing risk) OR volume_mult
#                below VERDICT_MIN_VOLUME_MULT (rally without real
#                participation, likelier to fade).
#   GREENLIGHT — not skip AND momentum_score >= VERDICT_GREENLIGHT_SCORE_MIN
#                AND the nearest actionable target (targets.smcPool if
#                present, else targets.resistance) is within
#                VERDICT_TARGET_MAX_PCT distance_pct.
#   WATCH      — everything else that fired: momentum without a close-enough
#                target, or a target without enough momentum/confirmation.
#
# A rally's own RALLY_VOLUME_MULT gate (1.3x) already requires *some* excess
# volume to fire at all; VERDICT_MIN_VOLUME_MULT (1.5x) is deliberately a
# notch higher — a rally can clear the firing gate but still read as
# volume-light for a greenlight.
VERDICT_MIN_VOLUME_MULT = 1.5
VERDICT_GREENLIGHT_SCORE_MIN = 45.0
VERDICT_TARGET_MAX_PCT = 2.5

VERDICT_SKIP: Verdict = "skip"
VERDICT_WATCH: Verdict = "watch"
VERDICT_GREENLIGHT: Verdict = "greenlight"


def _clip(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _round(value: float, digits: int = 4) -> float:
    return round(value, digits)


def _distance_pct(price: float, ref: float) -> float:
    return ((price - ref) / ref * 100) if ref else 0.0


@dataclass(slots=True)
class RallyTarget:
    price: float
    distance_pct: float
    label: str
    detail: str

    def to_dict(self) -> dict[str, float | str]:
        return {
            "price": self.price,
            "distance_pct": self.distance_pct,
            "label": self.label,
            "detail": self.detail,
        }


@dataclass(slots=True)
class RallyRead:
    symbol: str
    direction: Direction
    gain_pct: float
    volume_mult: float
    momentum_score: float
    extended: bool
    # keys: "smcPool" (optional), "resistance", "liquidation" -> RallyTarget.to_dict()
    targets: dict[str, dict]
    # keys: "bslAbove", "sslBelow", "longLiq" -> list[RallyTarget.to_dict()]
    liquidity: dict[str, list[dict]]
    explanation: str
    evaluated_at: int
    oi_available: bool
    # Human-language greenlight/watch/skip classification — see the "verdict
    # thresholds" section above for the deterministic rules. `verdict_reason`
    # is a short English phrase the UI shows verbatim next to the pill.
    verdict: Verdict
    verdict_reason: str
    version: str = field(default=RALLY_WATCHER_VERSION)


def _pool_target(pool: LiquidityPool, ref_price: float, label: str) -> RallyTarget:
    return RallyTarget(
        price=pool.price,
        distance_pct=round(_distance_pct(pool.price, ref_price), 3),
        label=label,
        detail=f"{pool.tier.lower()} liquidity pool ({pool.confidence}% confidence), {pool.side.upper()}",
    )


def _select_resistance(
    swing_highs_above: list[float], window_low: float, window_high: float, last_close: float
) -> tuple[float, str, str]:
    """The SECONDARY target: whichever of (nearest swing high above) or (a
    measured-move projection off the rally's own base) sits closer to current
    price. `swing_highs_above` must already be filtered to prices above
    `last_close`; the measured move always exists (window_high projected an
    equal distance past the rally's own low)."""
    measured_move = window_high + (window_high - window_low)
    candidates: list[tuple[float, str, str]] = []
    if swing_highs_above:
        candidates.append(
            (min(swing_highs_above), "Swing high", "nearest confirmed swing high above current price")
        )
    candidates.append(
        (
            measured_move,
            "Measured move",
            f"measured-move projection: rally base {window_low:.6g} -> window high "
            f"{window_high:.6g}, projected an equal distance further",
        )
    )
    return min(candidates, key=lambda c: abs(c[0] - last_close))


def _liquidation_targets(
    vwap_entry: float, current_price: float
) -> tuple[RallyTarget, RallyTarget]:
    """Returns (short_liq_target, long_liq_target). Both are ESTIMATES off an
    assumed average leverage (`AVG_LEVERAGE`), never a fact about any real
    position — see the module docstring for the formulas."""
    short_liq = vwap_entry * (1 + 1 / AVG_LEVERAGE) / (1 + MMR)
    long_liq = vwap_entry * (1 - 1 / AVG_LEVERAGE) / (1 - MMR)
    leverage_label = f"{AVG_LEVERAGE:g}x"
    short_target = RallyTarget(
        price=short_liq,
        distance_pct=round(_distance_pct(short_liq, current_price), 3),
        label=f"Est. {leverage_label} short-liq",
        detail=(
            f"est. avg-leverage ({leverage_label}) liquidation — where a short opened near the "
            f"VWAP entry proxy ({vwap_entry:.6g}) would be forced to cover, adding fuel to the move. "
            "This is an ESTIMATE, not a fact about any real position."
        ),
    )
    long_target = RallyTarget(
        price=long_liq,
        distance_pct=round(_distance_pct(long_liq, current_price), 3),
        label=f"Est. {leverage_label} long-liq",
        detail=(
            f"est. avg-leverage ({leverage_label}) liquidation for a long opened near the VWAP "
            f"entry proxy ({vwap_entry:.6g}) — context only, below current price."
        ),
    )
    return short_target, long_target


def _classify_verdict(
    *,
    extended: bool,
    volume_mult: float,
    momentum_score: float,
    nearest_target_distance_pct: float | None,
) -> tuple[Verdict, str]:
    """Pure classification of an already-fired read — see the "verdict
    thresholds" module-level comment for the rules. `nearest_target_distance_pct`
    is `targets.smcPool`'s `distance_pct` if present, else `targets.resistance`'s
    (always present when a read fires) — passed as a plain float so this stays
    testable without constructing full `RallyTarget` dicts."""
    reasons: list[str] = []
    if extended:
        reasons.append("already extended — chasing risk, not a fresh entry")
    if volume_mult < VERDICT_MIN_VOLUME_MULT:
        reasons.append("volume light relative to the move")
    if reasons:
        return VERDICT_SKIP, "; ".join(reasons)

    target_close = (
        nearest_target_distance_pct is not None and nearest_target_distance_pct <= VERDICT_TARGET_MAX_PCT
    )
    if momentum_score >= VERDICT_GREENLIGHT_SCORE_MIN and target_close:
        return (
            VERDICT_GREENLIGHT,
            f"strong momentum ({momentum_score:.0f}/100) with target only "
            f"{nearest_target_distance_pct:.1f}% away",
        )

    if momentum_score < VERDICT_GREENLIGHT_SCORE_MIN:
        return (
            VERDICT_WATCH,
            f"momentum score {momentum_score:.0f} below the {VERDICT_GREENLIGHT_SCORE_MIN:.0f} greenlight bar",
        )
    return (
        VERDICT_WATCH,
        f"nearest target still {nearest_target_distance_pct:.1f}% away"
        if nearest_target_distance_pct is not None
        else "no actionable target in range",
    )


def evaluate_rally(
    candles: list[Candle],
    oi: list[OiPoint] | None,
    funding: float | None,
    index: int = -1,
    symbol: str | None = None,
) -> RallyRead | None:
    """Evaluates the RALLY WATCHER read at `candles[index]`.

    Reads only `candles[: index + 1]` and `oi` samples at or before that
    bar's time — evaluating a truncated prefix at index -1 must equal
    evaluating the full series at the corresponding absolute index. Returns
    None when no rally qualifies (insufficient gain, low volume, or a faded
    close); an overextended rally still fires with `extended=True`, never
    None — the chasing risk is a label, not a gate.
    """
    if not candles:
        return None
    n_total = len(candles)
    idx = index if index >= 0 else n_total + index
    if idx < 0 or idx >= n_total:
        return None

    prefix = candles[: idx + 1]
    if len(prefix) < MIN_BARS_REQUIRED:
        return None
    evaluated_time = prefix[-1].time
    last_close = prefix[-1].close
    if last_close <= 0:
        return None

    rally_window = prefix[-RALLY_WINDOW_BARS:]
    base_close = prefix[-RALLY_WINDOW_BARS - 1].close
    if base_close <= 0:
        return None
    gain_pct = (last_close - base_close) / base_close * 100
    if gain_pct < RALLY_MIN_GAIN_PCT:
        return None

    window_low = min(c.low for c in rally_window)
    window_high = max(c.high for c in rally_window)
    window_range = window_high - window_low
    # Fade guard: a rally that closes back in the lower half of its own
    # window range is not a rally — it already rolled over.
    if window_range > 0 and last_close < window_low + 0.5 * window_range:
        return None

    trailing_start = len(prefix) - RALLY_WINDOW_BARS - VOLUME_TRAILING_BARS
    trailing = prefix[trailing_start : len(prefix) - RALLY_WINDOW_BARS]
    if len(trailing) < VOLUME_TRAILING_BARS:
        return None
    window_avg_vol = _mean([c.volume for c in rally_window])
    trailing_avg_vol = _mean([c.volume for c in trailing])
    volume_mult = (window_avg_vol / trailing_avg_vol) if trailing_avg_vol > 0 else 0.0
    if volume_mult < RALLY_VOLUME_MULT:
        return None

    extended = gain_pct >= RALLY_EXTENDED_PCT

    # ── SMC structure/liquidity, same call sequence as quant.evaluate_signal ──
    structure_window = prefix[-LOOKBACK_BARS:]
    pivots = compute_pivots(structure_window)
    structure = compute_market_structure(pivots)
    pools = compute_liquidity_pools(structure)

    bsl_above = sorted(
        (p for p in pools if p.side == "bsl" and p.intact and p.price > last_close),
        key=lambda p: p.price,
    )
    ssl_below = sorted(
        (p for p in pools if p.side == "ssl" and p.intact and p.price < last_close),
        key=lambda p: p.price,
        reverse=True,
    )

    targets: dict[str, dict] = {}
    liquidity: dict[str, list[dict]] = {
        "bslAbove": [_pool_target(p, last_close, "BSL").to_dict() for p in bsl_above[:2]],
        "sslBelow": [_pool_target(p, last_close, "SSL").to_dict() for p in ssl_below[:2]],
    }

    nearest_bsl = bsl_above[0] if bsl_above else None
    if nearest_bsl is not None:
        targets["smcPool"] = _pool_target(nearest_bsl, last_close, "BSL pool").to_dict()

    # ── resistance: nearer of the nearest swing high above, or a measured
    # move projected off the rally's own base (window_low -> window_high).
    swing_highs_above = sorted(
        s.price for s in structure.swings if s.kind == "high" and s.price > last_close
    )
    nearest_resistance = _select_resistance(swing_highs_above, window_low, window_high, last_close)
    targets["resistance"] = RallyTarget(
        price=nearest_resistance[0],
        distance_pct=round(_distance_pct(nearest_resistance[0], last_close), 3),
        label=nearest_resistance[1],
        detail=nearest_resistance[2],
    ).to_dict()

    # ── liquidation estimate ──
    vwap_slice = prefix[-ENTRY_VWAP_BARS:]
    vwap_total_vol = sum(c.volume for c in vwap_slice)
    vwap_entry = (
        sum(c.close * c.volume for c in vwap_slice) / vwap_total_vol
        if vwap_total_vol > 0
        else last_close
    )
    filtered_oi = [p for p in (oi or []) if p.time <= evaluated_time]
    oi_available = len(filtered_oi) > 0
    short_liq_target, long_liq_target = _liquidation_targets(vwap_entry, last_close)
    targets["liquidation"] = short_liq_target.to_dict()
    liquidity["longLiq"] = [long_liq_target.to_dict()]

    # ── momentum score ──
    gain_component = _clip((gain_pct - RALLY_MIN_GAIN_PCT) / (RALLY_EXTENDED_PCT - RALLY_MIN_GAIN_PCT))
    volume_component = _clip(
        (volume_mult - RALLY_VOLUME_MULT) / (VOLUME_SCORE_CAP_MULT - RALLY_VOLUME_MULT)
    )
    proximity_component = (
        _clip((last_close - window_low) / window_range) if window_range > 0 else 1.0
    )
    liquidity_bonus = 0.0
    if nearest_bsl is not None:
        bsl_distance_pct = _distance_pct(nearest_bsl.price, last_close)
        liquidity_bonus = _clip((RALLY_TARGET_BONUS_PCT - bsl_distance_pct) / RALLY_TARGET_BONUS_PCT)

    momentum_score = 100 * (
        WEIGHT_GAIN * gain_component
        + WEIGHT_VOLUME * volume_component
        + WEIGHT_PROXIMITY * proximity_component
        + WEIGHT_LIQUIDITY_BONUS * liquidity_bonus
    )
    if extended:
        momentum_score = min(momentum_score, EXTENDED_SCORE_CAP)
    momentum_score = round(_clip(momentum_score, 0.0, 100.0), 2)

    name = symbol or "This asset"
    primary_target = nearest_bsl.price if nearest_bsl is not None else nearest_resistance[0]
    nearest_target_distance_pct: float = (
        targets["smcPool"]["distance_pct"] if "smcPool" in targets else targets["resistance"]["distance_pct"]
    )
    explanation = (
        f"{name} rallied +{gain_pct:.1f}% in 15m on {volume_mult:.1f}x volume — nearest target "
        f"{'the BSL pool' if nearest_bsl is not None else nearest_resistance[1].lower()} at "
        f"{primary_target:.6g} ({nearest_target_distance_pct:+.1f}%), est. short-liq at "
        f"{short_liq_target.price:.6g}."
        + (" Already extended — chasing risk, not an entry." if extended else "")
    )

    verdict, verdict_reason = _classify_verdict(
        extended=extended,
        volume_mult=volume_mult,
        momentum_score=momentum_score,
        nearest_target_distance_pct=nearest_target_distance_pct,
    )

    return RallyRead(
        symbol=symbol or "",
        direction="long",
        gain_pct=round(gain_pct, 3),
        volume_mult=round(volume_mult, 3),
        momentum_score=momentum_score,
        extended=extended,
        targets=targets,
        liquidity=liquidity,
        explanation=explanation,
        verdict=verdict,
        verdict_reason=verdict_reason,
        evaluated_at=evaluated_time,
        oi_available=oi_available,
    )
