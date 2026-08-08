"""REACCUMULATION / SECOND EXPANSION discovery detector.

A market-DISCOVERY pattern, not a trading decision: it flags assets whose
recent history reads as *previous impulse -> meaningful retracement ->
base/compression -> price stabilization -> OI reset -> OI rebuild -> price+OI
expansion*, i.e. a candidate for a second leg out of reaccumulation. It makes
no win-rate claim and gates no order. Deliberately outside the trading
engine, like `spike.py`: no `ENGINE_VERSION`, no decision/trigger semantics,
its own `REACCUMULATION_VERSION` provenance instead.

Replay-safety is the whole point of this module, so it is worth stating the
contract precisely: `evaluate_reaccumulation(candles, oi_history, index)`
reads only `candles[: index + 1]` and only `oi_history` samples timestamped at
or before that bar's time. Evaluating the full series at index `i` and
evaluating `candles[: i + 1]` at index `-1` must be byte-identical — the test
suite pins this directly.

`oi_history` is typed as a list of `(time, value)` samples (`OiPoint`) rather
than the bare floats sketched in the spec that commissioned this module:
correctness here depends on knowing *when* each OI sample was taken so it can
be excluded once it falls after the evaluated bar, and a list of floats
carries no such timestamp.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from smc.analysis import compute_ema_series
from smc.types import Candle

Direction = Literal["long", "short"]
ReaccumulationState = Literal["SECOND_EXPANSION", "ACCUMULATING"]

# Provenance stamp for `signal_events.source_version` and `ReaccumulationRead.version`.
REACCUMULATION_VERSION = "1.0.0"

# ── window sizing ────────────────────────────────────────────────────────────
# 1H bars; 7 days is enough room for an impulse, its retracement, a base, and
# a fresh expansion without reaching back into an unrelated prior cycle.
LOOKBACK_BARS = 168
# Below this many bars in the lookback there isn't room for all four phases —
# bail out rather than force a read on a half-formed window.
MIN_BARS_REQUIRED = 90

# ── previous impulse ─────────────────────────────────────────────────────────
IMPULSE_MIN_BARS = 6
IMPULSE_MAX_BARS = 48
# The impulse's start->end move must clear this multiple of the window's
# average true range — a relative bar so BTC and a micro-cap are judged on
# their own volatility, not a fixed percent.
IMPULSE_ATR_MULT = 4.0
# Bars reserved after the impulse for retracement + base + expansion; the
# impulse search never looks past `len(window) - IMPULSE_SEARCH_RESERVE_BARS`.
IMPULSE_SEARCH_RESERVE_BARS = 36

# ── retracement ──────────────────────────────────────────────────────────────
# A retracement must give back a meaningful chunk of the impulse (evidence the
# move can reverse) without erasing it (evidence the impulse was real).
RETRACE_MIN_FRACTION = 0.30
RETRACE_MAX_FRACTION = 0.70
# How far past the impulse's end the retracement extreme may be found.
RETRACE_SEARCH_MAX_BARS = 96

# ── base / accumulation ──────────────────────────────────────────────────────
BASE_MIN_BARS = 24
# Bars of base for full length credit; longer bases score no higher.
BASE_LENGTH_TARGET_BARS = 48
# Base-era ATR / impulse-era ATR must fall below this for any compression credit.
BASE_RANGE_COMPRESSION_MAX = 0.65
# If the base makes a new low (long case) beyond this fraction past the
# retracement extreme, it reads as continued trend, not stabilization.
BASE_DOWNTREND_MAX_DRIFT = 0.12
# baseQuality floor to ever call the state ACCUMULATING (vs. no pattern at all).
ACCUMULATING_BASE_MIN = 0.40

# ── OI reset / rebuild ───────────────────────────────────────────────────────
# The nearest OI sample at or before a queried bar must be within this many
# seconds of it, or the read is treated as missing rather than stale.
OI_ALIGN_TOLERANCE_S = 2 * 60 * 60
# Fraction of the impulse-era OI buildup that must unwind during base for full
# oiReset credit.
OI_RESET_TARGET_FRACTION = 0.50
# Fraction of that same buildup that must rebuild by the current bar for full
# oiRebuild credit.
OI_REBUILD_TARGET_FRACTION = 0.30
# When OI is available, SECOND_EXPANSION additionally requires at least this
# much oiRebuild — otherwise a pure price pump with dead OI could still clear
# the weighted score threshold on strong price-only components.
OI_REBUILD_GATE_MIN = 0.15

# ── current expansion ────────────────────────────────────────────────────────
EXPANSION_LOOKBACK_BARS = 6
EXPANSION_VOLUME_MULT = 1.3
# Breakout score decays back to 0 by this % past the base high/low — an
# expansion already this extended is not a *fresh* second leg.
EXPANSION_OVEREXTENSION_MAX_PCT = 25.0
# currentExpansion floor to ever fire SECOND_EXPANSION, independent of the
# weighted score — without this a strong impulse+retracement+base could clear
# the fire threshold with no expansion evidence at all.
EXPANSION_CONFIRM_MIN = 0.40

# ── component weights ────────────────────────────────────────────────────────
# Sum to 1.0. When OI is unavailable, the two OI weights drop out entirely
# (not scored as zero — excluded) and the rest renormalize, so a price-only
# read can still reach 100.
WEIGHT_PREVIOUS_IMPULSE = 0.20
WEIGHT_RETRACEMENT_QUALITY = 0.15
WEIGHT_BASE_QUALITY = 0.20
WEIGHT_OI_RESET = 0.15
WEIGHT_OI_REBUILD = 0.10
WEIGHT_CURRENT_EXPANSION = 0.20
_PRICE_ONLY_WEIGHT = (
    WEIGHT_PREVIOUS_IMPULSE + WEIGHT_RETRACEMENT_QUALITY + WEIGHT_BASE_QUALITY + WEIGHT_CURRENT_EXPANSION
)

# score >= this (plus the expansion/OI gates above) => SECOND_EXPANSION.
FIRE_THRESHOLD = 60.0

# conviction mapping for `signal_events.conviction` — floors, checked high to low.
CONVICTION_BANDS: tuple[tuple[float, str], ...] = (
    (90.0, "very_high"),
    (75.0, "high"),
    (60.0, "medium"),
    (40.0, "low"),
)


def conviction_for_score(score: float) -> str | None:
    """None below 40 — the worker pass writes no signal_events row for those."""
    for floor, label in CONVICTION_BANDS:
        if score >= floor:
            return label
    return None


@dataclass(slots=True)
class OiPoint:
    """One open-interest-value sample, on the same second-epoch axis as `Candle.time`."""

    time: int
    value: float


@dataclass(slots=True)
class ReaccumulationRead:
    pattern: Literal["REACCUMULATION"]
    state: ReaccumulationState
    score: float
    direction: Direction
    # previousImpulse / retracementQuality / baseQuality / oiReset / oiRebuild /
    # currentExpansion -> {"score": 0..1, "detail": "..."}
    evidence: dict[str, dict[str, Any]]
    explanation: str
    evaluated_at: int
    oi_available: bool
    version: str = REACCUMULATION_VERSION
    impulse_start_time: int = 0
    impulse_end_time: int = 0
    impulse_magnitude_pct: float = 0.0
    retracement_time: int = 0
    retracement_fraction: float = 0.0
    base_start_time: int = 0
    base_end_time: int = 0
    base_high: float = 0.0
    base_low: float = 0.0
    breakout_pct: float = 0.0


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _clip(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _true_range(prev_close: float, bar: Candle) -> float:
    return max(bar.high - bar.low, abs(bar.high - prev_close), abs(bar.low - prev_close))


def _atr(candles: list[Candle]) -> float:
    if len(candles) < 2:
        return 0.0
    trs = [_true_range(candles[i - 1].close, candles[i]) for i in range(1, len(candles))]
    return _mean(trs)


# ── previous impulse ─────────────────────────────────────────────────────────


@dataclass(slots=True)
class _Impulse:
    start_idx: int
    end_idx: int
    direction: Direction
    magnitude: float
    magnitude_pct: float


def _find_impulse(window: list[Candle]) -> _Impulse | None:
    """The largest close-to-close move over IMPULSE_MIN_BARS..IMPULSE_MAX_BARS
    bars that ends early enough to leave IMPULSE_SEARCH_RESERVE_BARS for
    everything after it. `window` is already bounded to LOOKBACK_BARS, so the
    O(bars * max_len) scan stays cheap."""
    n = len(window)
    search_end = n - IMPULSE_SEARCH_RESERVE_BARS
    if search_end <= IMPULSE_MIN_BARS:
        return None

    atr = _atr(window[: search_end + 1])
    if atr <= 0:
        return None

    best: _Impulse | None = None
    for start in range(0, search_end - IMPULSE_MIN_BARS + 1):
        max_len = min(IMPULSE_MAX_BARS, search_end - start)
        for length in range(IMPULSE_MIN_BARS, max_len + 1):
            end = start + length
            move = window[end].close - window[start].close
            magnitude = abs(move)
            if best is None or magnitude > best.magnitude:
                start_price = window[start].close
                best = _Impulse(
                    start_idx=start,
                    end_idx=end,
                    direction="long" if move > 0 else "short",
                    magnitude=magnitude,
                    magnitude_pct=(magnitude / start_price * 100) if start_price > 0 else 0.0,
                )

    if best is None or best.magnitude < IMPULSE_ATR_MULT * atr:
        return None
    return best


def _impulse_score(impulse: _Impulse, window: list[Candle]) -> tuple[float, str]:
    atr = _atr(window[: impulse.end_idx + 1])
    threshold = IMPULSE_ATR_MULT * atr
    ratio = (impulse.magnitude / threshold) if threshold > 0 else 0.0
    # 0 at exactly the qualifying threshold, 1 by 2x the threshold.
    score = _clip(ratio - 1.0)
    bars = impulse.end_idx - impulse.start_idx
    detail = (
        f"{impulse.direction} impulse of {impulse.magnitude_pct:.1f}% over {bars} bars "
        f"({ratio:.1f}x the qualifying move)"
    )
    return score, detail


# ── retracement ──────────────────────────────────────────────────────────────


@dataclass(slots=True)
class _Retracement:
    idx: int
    fraction: float


def _find_retracement(window: list[Candle], impulse: _Impulse) -> _Retracement | None:
    """The deepest pullback against the impulse within RETRACE_SEARCH_MAX_BARS
    of its end. None if the impulse's start price is fully erased (direction
    invalidated) or there is no room left to search."""
    search_last = min(len(window) - 1, impulse.end_idx + RETRACE_SEARCH_MAX_BARS)
    if search_last <= impulse.end_idx:
        return None

    start_price = window[impulse.start_idx].close
    end_price = window[impulse.end_idx].close
    candidates = range(impulse.end_idx, search_last + 1)

    if impulse.direction == "long":
        idx = min(candidates, key=lambda i: window[i].low)
        extreme = window[idx].low
        if extreme <= start_price:
            return None
        fraction = (end_price - extreme) / impulse.magnitude if impulse.magnitude > 0 else 0.0
    else:
        idx = max(candidates, key=lambda i: window[i].high)
        extreme = window[idx].high
        if extreme >= start_price:
            return None
        fraction = (extreme - end_price) / impulse.magnitude if impulse.magnitude > 0 else 0.0

    return _Retracement(idx=idx, fraction=max(0.0, fraction))


def _retracement_score(fraction: float) -> tuple[float, str]:
    if fraction < RETRACE_MIN_FRACTION:
        return 0.0, (
            f"retracement too shallow ({fraction * 100:.0f}% of the impulse — "
            f"needs >= {RETRACE_MIN_FRACTION * 100:.0f}% to be meaningful)"
        )
    if fraction > RETRACE_MAX_FRACTION:
        return 0.0, (
            f"retracement too deep ({fraction * 100:.0f}% of the impulse — "
            "the advance is mostly given back)"
        )
    mid = (RETRACE_MIN_FRACTION + RETRACE_MAX_FRACTION) / 2
    half = (RETRACE_MAX_FRACTION - RETRACE_MIN_FRACTION) / 2
    score = _clip(1 - abs(fraction - mid) / half)
    detail = (
        f"retraced {fraction * 100:.0f}% of the impulse — inside the "
        f"{RETRACE_MIN_FRACTION * 100:.0f}-{RETRACE_MAX_FRACTION * 100:.0f}% band "
        "that keeps the advance intact"
    )
    return score, detail


# ── base / accumulation ──────────────────────────────────────────────────────


def _base_metrics(
    window: list[Candle], impulse: _Impulse, retracement: _Retracement
) -> tuple[float, str, list[Candle], int, int]:
    """Returns (score, detail, base_candles, base_start_idx, base_end_idx).
    `base_end_idx` is exclusive — the tail after it is the expansion window."""
    n = len(window)
    base_start = retracement.idx
    base_end = n - EXPANSION_LOOKBACK_BARS
    base = window[base_start:base_end]
    if len(base) < BASE_MIN_BARS:
        return (
            0.0,
            f"base window too short ({len(base)} bars, needs >= {BASE_MIN_BARS})",
            base,
            base_start,
            base_end,
        )

    retracement_price = window[retracement.idx].low if impulse.direction == "long" else window[retracement.idx].high
    if impulse.direction == "long":
        worst = min(c.low for c in base)
        if worst < retracement_price * (1 - BASE_DOWNTREND_MAX_DRIFT):
            return 0.0, "price broke well below the retracement low — still trending, not basing", base, base_start, base_end
    else:
        worst = max(c.high for c in base)
        if worst > retracement_price * (1 + BASE_DOWNTREND_MAX_DRIFT):
            return 0.0, "price broke well above the retracement high — still trending, not basing", base, base_start, base_end

    impulse_era = window[impulse.start_idx : impulse.end_idx + 1]
    impulse_atr = _atr(impulse_era)
    base_atr = _atr(base)
    compression = (base_atr / impulse_atr) if impulse_atr > 0 else 1.0
    compression_score = _clip((BASE_RANGE_COMPRESSION_MAX - compression) / BASE_RANGE_COMPRESSION_MAX)

    half = len(base) // 2
    first_half, second_half = base[:half], base[half:]
    if impulse.direction == "long":
        first_extreme = min(c.low for c in first_half)
        second_extreme = min(c.low for c in second_half)
        diff = second_extreme - first_extreme
        tolerance = first_extreme * 0.05 or 1.0
        stability_score = 1.0 if diff >= 0 else _clip(1 + diff / tolerance)
    else:
        first_extreme = max(c.high for c in first_half)
        second_extreme = max(c.high for c in second_half)
        diff = first_extreme - second_extreme
        tolerance = first_extreme * 0.05 or 1.0
        stability_score = 1.0 if diff >= 0 else _clip(1 + diff / tolerance)

    length_score = _clip(len(base) / BASE_LENGTH_TARGET_BARS)

    score = 0.45 * compression_score + 0.30 * stability_score + 0.25 * length_score
    detail = (
        f"base of {len(base)} bars, range compressed to {compression * 100:.0f}% of the impulse era "
        f"({'higher lows' if impulse.direction == 'long' else 'lower highs'} "
        f"{'holding' if stability_score >= 0.5 else 'slipping'})"
    )
    return score, detail, base, base_start, base_end


# ── OI reset / rebuild ───────────────────────────────────────────────────────


def _nearest_oi_value(oi_points: list[OiPoint], t: int) -> float | None:
    """Latest OI sample at or before `t`, within OI_ALIGN_TOLERANCE_S. `oi_points`
    must already be sorted ascending and pre-filtered to <= the evaluated bar."""
    best: OiPoint | None = None
    for p in oi_points:
        if p.time > t:
            break
        best = p
    if best is None or t - best.time > OI_ALIGN_TOLERANCE_S:
        return None
    return best.value


def _oi_reset_rebuild(
    oi_points: list[OiPoint],
    window: list[Candle],
    impulse: _Impulse,
    base: list[Candle],
) -> tuple[float, str, float, str]:
    oi_start = _nearest_oi_value(oi_points, window[impulse.start_idx].time)
    oi_impulse_end = _nearest_oi_value(oi_points, window[impulse.end_idx].time)
    oi_base_end = _nearest_oi_value(oi_points, base[-1].time)
    oi_current = _nearest_oi_value(oi_points, window[-1].time)

    if None in (oi_start, oi_impulse_end, oi_base_end, oi_current):
        return 0.0, "insufficient OI coverage at the aligned times", 0.0, "insufficient OI coverage at the aligned times"

    buildup = oi_impulse_end - oi_start
    if buildup <= 0:
        return (
            0.0,
            "open interest did not expand during the prior impulse — no confirmed participation to reset",
            0.0,
            "no OI buildup to rebuild from",
        )

    unwind_fraction = _clip((oi_impulse_end - oi_base_end) / buildup, -1.0, 1.0)
    reset_score = _clip(max(0.0, unwind_fraction) / OI_RESET_TARGET_FRACTION)
    reset_detail = (
        f"OI unwound {unwind_fraction * 100:.0f}% of the impulse's buildup during retracement/base"
        if unwind_fraction > 0
        else "open interest did not unwind during retracement/base"
    )

    rebuild_fraction = _clip((oi_current - oi_base_end) / buildup, -1.0, 1.0)
    rebuild_score = _clip(max(0.0, rebuild_fraction) / OI_REBUILD_TARGET_FRACTION)
    rebuild_detail = (
        f"OI has rebuilt {rebuild_fraction * 100:.0f}% of the impulse's buildup since the base"
        if rebuild_fraction > 0
        else "open interest is not rebuilding since the base"
    )

    return reset_score, reset_detail, rebuild_score, rebuild_detail


# ── current expansion ────────────────────────────────────────────────────────


def _expansion_metrics(
    window: list[Candle],
    prefix: list[Candle],
    impulse: _Impulse,
    base: list[Candle],
    base_end_idx: int,
    oi_rebuild_score: float,
    oi_available: bool,
) -> tuple[float, str, float]:
    tail = window[base_end_idx:]
    if not tail or not base:
        return 0.0, "no expansion window to read", 0.0

    base_high = max(c.high for c in base)
    base_low = min(c.low for c in base)
    last = tail[-1]

    if impulse.direction == "long":
        raw_pct = ((last.close - base_high) / base_high * 100) if base_high > 0 else 0.0
    else:
        raw_pct = ((base_low - last.close) / base_low * 100) if base_low > 0 else 0.0

    # An already-overextended move is disqualifying, not merely discounted —
    # it fails the whole expansion read, not just its breakout subscore, so a
    # stale/extended pump can't borrow credit from volume/OI/EMA to still
    # clear the SECOND_EXPANSION gate.
    if raw_pct >= EXPANSION_OVEREXTENSION_MAX_PCT:
        return 0.0, f"already extended {raw_pct:.1f}% past the base — not a fresh second leg", raw_pct

    if raw_pct <= 0:
        breakout_score = 0.0
    else:
        peak = EXPANSION_OVEREXTENSION_MAX_PCT / 3
        if raw_pct <= peak:
            breakout_score = raw_pct / peak
        else:
            breakout_score = _clip(1 - (raw_pct - peak) / (EXPANSION_OVEREXTENSION_MAX_PCT - peak))

    base_vol_mean = _mean([c.volume for c in base])
    tail_vol_mean = _mean([c.volume for c in tail])
    volume_ratio = (tail_vol_mean / base_vol_mean) if base_vol_mean > 0 else 0.0
    volume_score = _clip((volume_ratio - 1) / (EXPANSION_VOLUME_MULT - 1)) if EXPANSION_VOLUME_MULT > 1 else 0.0

    ema9 = compute_ema_series(prefix, 9)
    ema21 = compute_ema_series(prefix, 21)
    ema_score = 0.0
    if ema9 and ema21:
        price, e9, e21 = prefix[-1].close, ema9[-1].value, ema21[-1].value
        if impulse.direction == "long":
            ema_score = 1.0 if price > e9 > e21 else (0.5 if price > e9 else 0.0)
        else:
            ema_score = 1.0 if price < e9 < e21 else (0.5 if price < e9 else 0.0)

    if oi_available:
        score = 0.45 * breakout_score + 0.25 * volume_score + 0.15 * oi_rebuild_score + 0.15 * ema_score
    else:
        score = (0.45 * breakout_score + 0.25 * volume_score + 0.15 * ema_score) / 0.85

    if raw_pct <= 0:
        detail = "price has not broken out of the base yet"
    else:
        detail = (
            f"breaking out {raw_pct:.1f}% past the base on {volume_ratio:.1f}x base volume"
            + (", EMA9>EMA21 reclaimed" if ema_score >= 1.0 else "")
        )
    return score, detail, raw_pct


# ── explanation ──────────────────────────────────────────────────────────────


def _build_explanation(
    direction: Direction, state: ReaccumulationState, oi_available: bool, symbol: str | None
) -> str:
    name = symbol or "This asset"
    tone = "upside" if direction == "long" else "downside"
    if state == "SECOND_EXPANSION":
        if oi_available:
            return (
                f"{name} previously experienced a significant {tone} impulsive expansion, retraced into a "
                "consolidation base, and is now reclaiming short-term structure while price, volume, and "
                "open interest expand together."
            )
        return (
            f"{name} previously experienced a significant {tone} impulsive expansion, retraced into a "
            "consolidation base, and is now reclaiming short-term structure on rising price and volume "
            "(open interest unavailable)."
        )
    return (
        f"{name} shows a base forming after a prior {tone} impulse and retracement — no confirmed "
        "second expansion yet."
    )


# ── entry point ──────────────────────────────────────────────────────────────


def evaluate_reaccumulation(
    candles: list[Candle],
    oi_history: list[OiPoint] | None,
    index: int = -1,
    symbol: str | None = None,
) -> ReaccumulationRead | None:
    """Evaluates the REACCUMULATION / SECOND EXPANSION read at `candles[index]`.

    Reads only `candles[: index + 1]` and OI samples at or before that bar's
    time — evaluating a truncated prefix at index -1 must equal evaluating the
    full series at the corresponding absolute index. Returns None for state
    NONE (no coherent pattern); a base without a confirmed expansion yet comes
    back as state ACCUMULATING, never None.
    """
    if not candles:
        return None
    n_total = len(candles)
    idx = index if index >= 0 else n_total + index
    if idx < 0 or idx >= n_total:
        return None

    prefix = candles[: idx + 1]
    evaluated_time = prefix[-1].time

    window = prefix[-LOOKBACK_BARS:]
    if len(window) < MIN_BARS_REQUIRED:
        return None

    impulse = _find_impulse(window)
    if impulse is None:
        return None

    retracement = _find_retracement(window, impulse)
    if retracement is None:
        return None
    retracement_score, retracement_detail = _retracement_score(retracement.fraction)
    if retracement_score <= 0.0:
        return None

    base_score, base_detail, base, base_start_idx, base_end_idx = _base_metrics(window, impulse, retracement)
    if base_score < ACCUMULATING_BASE_MIN:
        return None

    impulse_score, impulse_detail = _impulse_score(impulse, window)

    oi_points = sorted(
        (p for p in (oi_history or []) if p.time <= evaluated_time),
        key=lambda p: p.time,
    )
    oi_available = len(oi_points) >= 2

    if oi_available:
        oi_reset_score, oi_reset_detail, oi_rebuild_score, oi_rebuild_detail = _oi_reset_rebuild(
            oi_points, window, impulse, base
        )
    else:
        oi_reset_score, oi_reset_detail = 0.0, "no OI history supplied — component excluded from the score"
        oi_rebuild_score, oi_rebuild_detail = 0.0, "no OI history supplied — component excluded from the score"

    expansion_score, expansion_detail, breakout_pct = _expansion_metrics(
        window, prefix, impulse, base, base_end_idx, oi_rebuild_score, oi_available
    )

    if oi_available:
        score = (
            WEIGHT_PREVIOUS_IMPULSE * impulse_score
            + WEIGHT_RETRACEMENT_QUALITY * retracement_score
            + WEIGHT_BASE_QUALITY * base_score
            + WEIGHT_OI_RESET * oi_reset_score
            + WEIGHT_OI_REBUILD * oi_rebuild_score
            + WEIGHT_CURRENT_EXPANSION * expansion_score
        ) * 100
    else:
        score = (
            (
                WEIGHT_PREVIOUS_IMPULSE * impulse_score
                + WEIGHT_RETRACEMENT_QUALITY * retracement_score
                + WEIGHT_BASE_QUALITY * base_score
                + WEIGHT_CURRENT_EXPANSION * expansion_score
            )
            / _PRICE_ONLY_WEIGHT
        ) * 100

    fires = (
        score >= FIRE_THRESHOLD
        and expansion_score >= EXPANSION_CONFIRM_MIN
        and (not oi_available or oi_rebuild_score >= OI_REBUILD_GATE_MIN)
    )
    state: ReaccumulationState = "SECOND_EXPANSION" if fires else "ACCUMULATING"

    base_high = max(c.high for c in base)
    base_low = min(c.low for c in base)

    evidence = {
        "previousImpulse": {"score": round(impulse_score, 3), "detail": impulse_detail},
        "retracementQuality": {"score": round(retracement_score, 3), "detail": retracement_detail},
        "baseQuality": {"score": round(base_score, 3), "detail": base_detail},
        "oiReset": {"score": round(oi_reset_score, 3), "detail": oi_reset_detail},
        "oiRebuild": {"score": round(oi_rebuild_score, 3), "detail": oi_rebuild_detail},
        "currentExpansion": {"score": round(expansion_score, 3), "detail": expansion_detail},
    }

    return ReaccumulationRead(
        pattern="REACCUMULATION",
        state=state,
        score=round(_clip(score, 0.0, 100.0), 2),
        direction=impulse.direction,
        evidence=evidence,
        explanation=_build_explanation(impulse.direction, state, oi_available, symbol),
        evaluated_at=evaluated_time,
        oi_available=oi_available,
        impulse_start_time=window[impulse.start_idx].time,
        impulse_end_time=window[impulse.end_idx].time,
        impulse_magnitude_pct=round(impulse.magnitude_pct, 3),
        retracement_time=window[retracement.idx].time,
        retracement_fraction=round(retracement.fraction, 3),
        base_start_time=window[base_start_idx].time,
        base_end_time=window[max(base_end_idx - 1, base_start_idx)].time,
        base_high=base_high,
        base_low=base_low,
        breakout_pct=round(breakout_pct, 3),
    )
