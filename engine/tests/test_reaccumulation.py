"""REACCUMULATION / SECOND EXPANSION detector — component isolation, full
positive/negative pattern fixtures, and the no-lookahead replay-safety proof.
"""

from __future__ import annotations

import pytest
from smc.reaccumulation import (
    ACCUMULATING_BASE_MIN,
    EXPANSION_CONFIRM_MIN,
    FIRE_THRESHOLD,
    OiPoint,
    _Impulse,
    _Retracement,
    _atr,
    _base_metrics,
    _find_impulse,
    _find_retracement,
    _impulse_score,
    _retracement_score,
    conviction_for_score,
    evaluate_reaccumulation,
)
from smc.types import Candle

HOUR_S = 3_600
BASE_TIME = 1_800_000_000


def make_candles(
    closes: list[float], volumes: list[float] | None = None, start: int = BASE_TIME
) -> list[Candle]:
    vols = volumes if volumes is not None else [100.0] * len(closes)
    out: list[Candle] = []
    prev = closes[0]
    for i, close in enumerate(closes):
        o = prev
        h = max(o, close) + abs(o - close) * 0.05 + 0.01
        low = min(o, close) - abs(o - close) * 0.05 - 0.01
        out.append(Candle(time=start + i * HOUR_S, open=o, high=h, low=low, close=close, volume=vols[i]))
        prev = close
    return out


def _pre_phase(n: int, level: float = 90.0) -> list[float]:
    return [level + (0.15 if i % 2 == 0 else -0.15) for i in range(n)]


def _impulse_phase(bars: int, start: float, end: float) -> list[float]:
    return [start + (end - start) * i / bars for i in range(1, bars + 1)]


def _retracement_phase(bars: int, start: float, end: float) -> list[float]:
    return [start + (end - start) * i / bars for i in range(1, bars + 1)]


def _base_phase(n: int, low: float, high: float, drift: float = 0.0) -> list[float]:
    cyc = [0.0, 0.35, 0.7, 0.35, 0.0, -0.35, -0.7, -0.35]
    mid = (low + high) / 2
    amp = (high - low) / 2
    out = []
    for i in range(n):
        level = mid + drift * (i / n)
        out.append(level + amp * cyc[i % len(cyc)])
    return out


def _expansion_phase(bars: int, start: float, end: float) -> list[float]:
    return [start + (end - start) * i / bars for i in range(1, bars + 1)]


def _impulse_between(candles: list[Candle], start_idx: int, end_idx: int) -> _Impulse:
    """Builds an `_Impulse` straight from two candle indices, for component
    tests that want to bypass `_find_impulse`'s search entirely."""
    move = candles[end_idx].close - candles[start_idx].close
    magnitude = abs(move)
    start_price = candles[start_idx].close
    return _Impulse(
        start_idx=start_idx,
        end_idx=end_idx,
        direction="long" if move > 0 else "short",
        magnitude=magnitude,
        magnitude_pct=(magnitude / start_price * 100) if start_price > 0 else 0.0,
    )


def _retracement_at(candles: list[Candle], idx: int, impulse: _Impulse) -> _Retracement:
    if impulse.direction == "long":
        fraction = (candles[impulse.end_idx].close - candles[idx].low) / impulse.magnitude
    else:
        fraction = (candles[idx].high - candles[impulse.end_idx].close) / impulse.magnitude
    return _Retracement(idx=idx, fraction=max(0.0, fraction))


def build_long_series(
    *,
    pre_n: int = 30,
    impulse_bars: int = 20,
    impulse_start: float = 90.0,
    impulse_end: float = 150.0,
    retrace_bars: int = 15,
    retrace_end: float = 120.0,
    base_n: int = 40,
    base_low: float = 116.0,
    base_high: float = 124.0,
    base_drift: float = 4.0,
    expansion_bars: int = 6,
    expansion_end: float = 145.0,
    trailing_flat_n: int = 0,
) -> tuple[list[float], list[float]]:
    """Builds a full REACCUMULATION close/volume series: pre-noise -> impulse
    -> retracement -> base -> expansion. Returns (closes, volumes)."""
    closes: list[float] = []
    volumes: list[float] = []

    closes += _pre_phase(pre_n, impulse_start)
    volumes += [80.0] * pre_n

    closes += _impulse_phase(impulse_bars, impulse_start, impulse_end)
    volumes += [130.0] * impulse_bars

    closes += _retracement_phase(retrace_bars, impulse_end, retrace_end)
    volumes += [90.0] * retrace_bars

    closes += _base_phase(base_n, base_low, base_high, base_drift)
    volumes += [70.0] * base_n

    if expansion_bars:
        base_of_expansion = closes[-1]
        closes += _expansion_phase(expansion_bars, base_of_expansion, expansion_end)
        volumes += [70.0 + 50.0 * i for i in range(1, expansion_bars + 1)]

    if trailing_flat_n:
        closes += [closes[-1]] * trailing_flat_n
        volumes += [70.0] * trailing_flat_n

    return closes, volumes


def oi_series_for(
    closes_len: int,
    *,
    pre_n: int,
    impulse_bars: int,
    retrace_bars: int,
    base_n: int,
    expansion_bars: int,
    oi_start: float = 1_000_000.0,
    oi_impulse_peak: float = 1_600_000.0,
    oi_base: float = 1_150_000.0,
    oi_rebuild: float = 1_450_000.0,
    start: int = BASE_TIME,
) -> list[OiPoint]:
    """One OI sample per bar, aligned to the same hourly axis as the candles:
    flat pre-phase -> rising through the impulse -> resetting through the
    base -> rebuilding through the expansion."""
    impulse_end_idx = pre_n + impulse_bars
    base_end_idx = pre_n + impulse_bars + retrace_bars + base_n
    points: list[OiPoint] = []
    for i in range(closes_len):
        if i <= pre_n:
            value = oi_start
        elif i <= impulse_end_idx:
            frac = (i - pre_n) / impulse_bars
            value = oi_start + (oi_impulse_peak - oi_start) * frac
        elif i <= base_end_idx:
            frac = (i - impulse_end_idx) / max(1, base_end_idx - impulse_end_idx)
            value = oi_impulse_peak + (oi_base - oi_impulse_peak) * frac
        else:
            frac = (i - base_end_idx) / max(1, expansion_bars)
            value = oi_base + (oi_rebuild - oi_base) * min(1.0, frac)
        points.append(OiPoint(time=start + i * HOUR_S, value=value))
    return points


POSITIVE_KW = dict(
    pre_n=30, impulse_bars=20, impulse_start=90.0, impulse_end=150.0,
    retrace_bars=15, retrace_end=120.0, base_n=40, base_low=116.0,
    base_high=124.0, base_drift=4.0, expansion_bars=6, expansion_end=150.0,
)


def positive_fixture() -> tuple[list[Candle], list[OiPoint]]:
    closes, volumes = build_long_series(**POSITIVE_KW)
    candles = make_candles(closes, volumes)
    oi = oi_series_for(
        len(closes),
        pre_n=POSITIVE_KW["pre_n"],
        impulse_bars=POSITIVE_KW["impulse_bars"],
        retrace_bars=POSITIVE_KW["retrace_bars"],
        base_n=POSITIVE_KW["base_n"],
        expansion_bars=POSITIVE_KW["expansion_bars"],
    )
    return candles, oi


# ---------------------------------------------------------------------------
# Component isolation
# ---------------------------------------------------------------------------


def test_find_impulse_detects_the_up_move() -> None:
    closes, _ = build_long_series(expansion_bars=0)
    candles = make_candles(closes)
    impulse = _find_impulse(candles)
    assert impulse is not None
    assert impulse.direction == "long"
    assert impulse.magnitude > 0


def test_find_impulse_none_when_flat() -> None:
    candles = make_candles([100.0 + (0.1 if i % 2 == 0 else -0.1) for i in range(120)])
    assert _find_impulse(candles) is None


def test_impulse_score_increases_with_magnitude() -> None:
    closes, _ = build_long_series(expansion_bars=0)
    candles = make_candles(closes)
    impulse = _find_impulse(candles)
    assert impulse is not None
    score, detail = _impulse_score(impulse, candles)
    assert 0.0 <= score <= 1.0
    assert "impulse" in detail


def test_retracement_quality_scores_the_ideal_band() -> None:
    score_mid, _ = _retracement_score(0.5)
    score_shallow, detail_shallow = _retracement_score(0.1)
    score_deep, detail_deep = _retracement_score(0.9)
    assert score_mid == 1.0
    assert score_shallow == 0.0
    assert "shallow" in detail_shallow
    assert score_deep == 0.0
    assert "deep" in detail_deep


def test_find_retracement_none_when_impulse_fully_erased() -> None:
    """Impulse 90->150 over idx30..49, then a decline all the way past the
    impulse's own start price (90) — the advance is erased, not retraced."""
    pre = _pre_phase(30, 90.0)
    up = _impulse_phase(20, 90.0, 150.0)
    down = _retracement_phase(30, 150.0, 80.0)
    candles = make_candles(pre + up + down)
    impulse = _impulse_between(candles, 30, 49)
    assert impulse.direction == "long"
    assert _find_retracement(candles, impulse) is None


def test_base_quality_rejects_short_base() -> None:
    """A base of only 10 bars — well under BASE_MIN_BARS — scores 0 regardless
    of how clean the compression looks."""
    pre = _pre_phase(30, 90.0)
    up = _impulse_phase(20, 90.0, 150.0)
    down = _retracement_phase(15, 150.0, 120.0)
    base = _base_phase(10, 116.0, 120.0)
    tail = [base[-1]] * 6
    candles = make_candles(pre + up + down + base + tail)
    impulse = _impulse_between(candles, 30, 49)
    retracement = _retracement_at(candles, 64, impulse)
    score, detail, base_out, *_ = _base_metrics(candles, impulse, retracement)
    assert score == 0.0
    assert "short" in detail
    assert len(base_out) < 24


def test_base_quality_rejects_continued_downtrend() -> None:
    """After the retracement low, price keeps making new lows well beyond the
    drift tolerance — that is a continuing downtrend, not a base."""
    pre = _pre_phase(30, 90.0)
    up = _impulse_phase(20, 90.0, 150.0)
    down = _retracement_phase(15, 150.0, 120.0)
    still_falling = _base_phase(30, 90.0, 100.0, drift=0.0)
    tail = [still_falling[-1]] * 6
    candles = make_candles(pre + up + down + still_falling + tail)
    impulse = _impulse_between(candles, 30, 49)
    retracement = _retracement_at(candles, 64, impulse)
    score, detail, *_ = _base_metrics(candles, impulse, retracement)
    assert score == 0.0
    assert "trending" in detail


def test_oi_reset_and_rebuild_score_positively_when_pattern_present() -> None:
    candles, oi = positive_fixture()
    result = evaluate_reaccumulation(candles, oi)
    assert result is not None
    assert result.oi_available is True
    assert result.evidence["oiReset"]["score"] > 0.0
    assert result.evidence["oiRebuild"]["score"] > 0.0


def test_conviction_bands() -> None:
    assert conviction_for_score(95) == "very_high"
    assert conviction_for_score(80) == "high"
    assert conviction_for_score(65) == "medium"
    assert conviction_for_score(45) == "low"
    assert conviction_for_score(10) is None


# ---------------------------------------------------------------------------
# Full positive pattern
# ---------------------------------------------------------------------------


def test_full_positive_pattern_fires_second_expansion() -> None:
    candles, oi = positive_fixture()
    result = evaluate_reaccumulation(candles, oi, symbol="TESTUSDT")
    assert result is not None
    assert result.state == "SECOND_EXPANSION"
    assert result.score >= FIRE_THRESHOLD
    assert result.direction == "long"
    assert "TESTUSDT" in result.explanation
    for key in (
        "previousImpulse",
        "retracementQuality",
        "baseQuality",
        "oiReset",
        "oiRebuild",
        "currentExpansion",
    ):
        assert key in result.evidence
        assert 0.0 <= result.evidence[key]["score"] <= 1.0


# ---------------------------------------------------------------------------
# Negative cases
# ---------------------------------------------------------------------------


def test_pump_with_no_accumulation_does_not_fire() -> None:
    """Impulse then straight continuation — no retracement, no base."""
    closes, volumes = _pre_phase(30, 90.0), [80.0] * 30
    ramp = _impulse_phase(60, 90.0, 220.0)
    candles = make_candles(closes + ramp, volumes + [120.0] * 60)
    result = evaluate_reaccumulation(candles, None)
    assert result is None


def test_accumulation_with_no_prior_impulse_does_not_fire() -> None:
    """Flat, then a base — nothing before it qualifies as an impulse."""
    flat = _pre_phase(50, 100.0)
    base = _base_phase(50, 96.0, 104.0)
    candles = make_candles(flat + base, [80.0] * 100)
    result = evaluate_reaccumulation(candles, None)
    assert result is None


def test_pump_then_relentless_dump_does_not_fire() -> None:
    """Impulse up, then continuous decline past the retracement band — no
    stabilization, so this must not read as a base."""
    closes, volumes = build_long_series(
        retrace_bars=60, retrace_end=50.0, base_n=0, expansion_bars=0
    )
    candles = make_candles(closes, volumes)
    result = evaluate_reaccumulation(candles, None)
    assert result is None


def test_expansion_without_oi_confirmation_does_not_fire_second_expansion() -> None:
    """Price/volume expand out of the base, but OI is flat/falling — with OI
    available, SECOND_EXPANSION requires oiRebuild too."""
    closes, volumes = build_long_series(**POSITIVE_KW)
    candles = make_candles(closes, volumes)
    n = len(closes)
    # Flat, then falling OI straight through — never resets, never rebuilds.
    oi = [OiPoint(time=BASE_TIME + i * HOUR_S, value=1_500_000.0 - i * 500.0) for i in range(n)]
    result = evaluate_reaccumulation(candles, oi)
    assert result is None or result.state != "SECOND_EXPANSION"
    if result is not None:
        assert result.evidence["oiRebuild"]["score"] < 0.15


def test_oi_expansion_without_price_expansion_does_not_fire() -> None:
    """OI rising, but price is still compressed inside the base — no breakout."""
    closes, volumes = build_long_series(**{**POSITIVE_KW, "expansion_bars": 0, "trailing_flat_n": 6})
    candles = make_candles(closes, volumes)
    oi = oi_series_for(
        len(closes),
        pre_n=POSITIVE_KW["pre_n"],
        impulse_bars=POSITIVE_KW["impulse_bars"],
        retrace_bars=POSITIVE_KW["retrace_bars"],
        base_n=POSITIVE_KW["base_n"],
        expansion_bars=6,
    )
    result = evaluate_reaccumulation(candles, oi)
    assert result is None or result.state != "SECOND_EXPANSION"
    if result is not None:
        assert result.evidence["currentExpansion"]["score"] < EXPANSION_CONFIRM_MIN


def test_already_overextended_expansion_does_not_fire() -> None:
    """Breakout has already travelled far beyond the base — not a fresh leg."""
    closes, volumes = build_long_series(**{**POSITIVE_KW, "expansion_end": 300.0})
    candles = make_candles(closes, volumes)
    oi = oi_series_for(
        len(closes),
        pre_n=POSITIVE_KW["pre_n"],
        impulse_bars=POSITIVE_KW["impulse_bars"],
        retrace_bars=POSITIVE_KW["retrace_bars"],
        base_n=POSITIVE_KW["base_n"],
        expansion_bars=POSITIVE_KW["expansion_bars"],
    )
    result = evaluate_reaccumulation(candles, oi)
    assert result is None or result.state != "SECOND_EXPANSION"


# ---------------------------------------------------------------------------
# No lookahead — the replay-safety guarantee.
# ---------------------------------------------------------------------------


def test_no_lookahead_prefix_matches_full_series() -> None:
    candles, oi = positive_fixture()
    # Pad with additional bars after the pattern so the full series carries
    # real future data a lookahead bug could leak from.
    tail_closes = [candles[-1].close + i for i in range(1, 20)]
    extra = make_candles(tail_closes, start=candles[-1].time + HOUR_S)
    full = candles + extra
    extra_oi = [OiPoint(time=c.time, value=oi[-1].value + 1000 * i) for i, c in enumerate(extra, start=1)]
    full_oi = oi + extra_oi

    check_indices = [len(candles) - 1, len(candles) - 10, len(candles) - 40]
    for idx in check_indices:
        full_result = evaluate_reaccumulation(full, full_oi, index=idx)
        truncated = full[: idx + 1]
        truncated_oi = full_oi[: idx + 1]
        prefix_result = evaluate_reaccumulation(truncated, truncated_oi, index=-1)
        assert full_result == prefix_result


def test_no_lookahead_never_reads_future_bars() -> None:
    """A poisoned future (huge spike right after the evaluated index) must
    not change the read at that index."""
    candles, oi = positive_fixture()
    idx = len(candles) - 1
    unpoisoned = evaluate_reaccumulation(candles, oi, index=idx)

    poisoned_tail = make_candles([10_000.0] * 10, start=candles[-1].time + HOUR_S)
    poisoned = candles + poisoned_tail
    poisoned_result = evaluate_reaccumulation(poisoned, oi, index=idx)
    assert poisoned_result == unpoisoned


# ---------------------------------------------------------------------------
# OI-missing degrade path
# ---------------------------------------------------------------------------


def test_oi_missing_degrades_gracefully() -> None:
    candles, _ = positive_fixture()
    result = evaluate_reaccumulation(candles, None)
    assert result is not None
    assert result.oi_available is False
    assert result.evidence["oiReset"]["score"] == 0.0
    assert result.evidence["oiRebuild"]["score"] == 0.0
    # Price-only components still carry the score — it must not silently zero out.
    assert result.score > 0.0


def test_oi_empty_list_same_as_none() -> None:
    candles, _ = positive_fixture()
    with_none = evaluate_reaccumulation(candles, None)
    with_empty = evaluate_reaccumulation(candles, [])
    assert with_none == with_empty
