"""MARKET CONTEXT (slow lane) + CONTEXT ALIGNMENT + 1m MICRO STRUCTURE.

Three small pure modules that must stay independent of each other and of the
event layer. What is pinned here:

* a timeframe read is structural, not a percentage move;
* the aggregate badge is weighted 4H > 1H > 15m, and 5M gets no vote;
* conflict reads as "mixed", never as a forced direction;
* the badge does not flip on one disagreeing refresh;
* alignment classifies aligned / counter-trend / mixed and nothing else — no
  buy, no sell;
* bullish and bearish are exact mirrors throughout.
"""

from __future__ import annotations

import math
from dataclasses import replace

import pytest

from smc.context_alignment import classify
from smc.market_context import (
    DEFAULT_CONTEXT_CONFIG,
    TimeframeRead,
    aggregate_bias,
    build_context,
    read_timeframe,
)
from smc.micro_structure import is_new_break, read_micro_structure
from smc.types import Candle

T0 = 1_700_000_000.0
CFG = DEFAULT_CONTEXT_CONFIG


def wave(
    count: int = 120,
    *,
    start: float = 100.0,
    drift: float = 0.35,
    amplitude: float = 1.2,
    period: int = 12,
    step: int = 3_600,
) -> list[Candle]:
    """A swinging series with a linear drift.

    Drift up prints higher highs and higher lows (an uptrend), drift down the
    mirror, and drift zero a range — which is exactly the three structural
    states the reader has to distinguish.
    """
    candles: list[Candle] = []
    for index in range(count):
        mid = start + drift * index + amplitude * math.sin(2 * math.pi * index / period)
        candles.append(
            Candle(
                time=int(T0) + index * step,
                open=mid,
                high=mid + amplitude * 0.5,
                low=mid - amplitude * 0.5,
                close=mid,
                volume=1_000.0,
            )
        )
    return candles


def read(timeframe: str, **kwargs: object) -> TimeframeRead:
    result = read_timeframe(timeframe, wave(**kwargs), T0, CFG)  # type: ignore[arg-type]
    assert result is not None
    return result


def synthetic(timeframe: str, bias: str, now: float = T0) -> TimeframeRead:
    """A hand-built read, for testing aggregation without generating tape."""
    return TimeframeRead(
        timeframe=timeframe,  # type: ignore[arg-type]
        bias=bias,  # type: ignore[arg-type]
        trend="uptrend" if bias == "bullish" else "downtrend" if bias == "bearish" else "range",
        event=None,
        event_label=None,
        change_pct=1.0 if bias == "bullish" else -1.0 if bias == "bearish" else 0.0,
        bars=120,
        last_candle_time=int(now),
        computed_at=now,
    )


# ── per-timeframe reads ──────────────────────────────────────────────────────


def test_a_drifting_up_series_reads_bullish() -> None:
    result = read("4H", drift=0.35)
    assert result.bias == "bullish"
    assert result.trend == "uptrend"
    assert result.change_pct > 0


def test_a_drifting_down_series_reads_bearish() -> None:
    result = read("4H", drift=-0.35)
    assert result.bias == "bearish"
    assert result.trend == "downtrend"
    assert result.change_pct < 0


def test_bullish_and_bearish_reads_are_mirrors() -> None:
    up = read("1H", drift=0.35)
    down = read("1H", drift=-0.35)
    assert (up.bias, down.bias) == ("bullish", "bearish")
    assert (up.trend, down.trend) == ("uptrend", "downtrend")
    assert up.change_pct > 0 > down.change_pct
    # Not exactly equal in magnitude: the same absolute drift is a slightly
    # larger *percentage* on the way down, off a shrinking base.
    assert abs(up.change_pct) == pytest.approx(abs(down.change_pct), rel=0.05)


def test_a_flat_range_does_not_read_directionally() -> None:
    assert read("15M", drift=0.0).trend == "range"


def test_too_little_history_reads_nothing_rather_than_guessing() -> None:
    assert read_timeframe("4H", wave(count=10), T0, CFG) is None


def test_a_read_goes_stale() -> None:
    result = read("4H")
    assert result.is_stale(T0 + 10, CFG) is False
    assert result.is_stale(T0 + CFG.read_ttl_seconds + 1, CFG) is True


# ── aggregation ──────────────────────────────────────────────────────────────


def test_the_higher_timeframes_outweigh_the_lower_ones() -> None:
    """4H+1H bullish beats a bearish 15m — the badge is a regime read, not a
    majority vote."""
    reads = (
        synthetic("4H", "bullish"),
        synthetic("1H", "bullish"),
        synthetic("15M", "bearish"),
    )
    bias, score = aggregate_bias(reads, CFG)
    assert bias == "bullish"
    assert score == pytest.approx((3 + 2 - 1) / 6, abs=0.01)


def test_conflict_reads_as_mixed_rather_than_a_forced_direction() -> None:
    reads = (synthetic("4H", "bullish"), synthetic("1H", "bearish"))
    bias, _ = aggregate_bias(reads, CFG)
    assert bias == "mixed"


def test_quiet_structure_reads_as_neutral_not_mixed() -> None:
    """Nobody leaning is a different situation from timeframes disagreeing."""
    reads = (synthetic("4H", "neutral"), synthetic("1H", "neutral"))
    assert aggregate_bias(reads, CFG)[0] == "neutral"


def test_the_5m_read_gets_no_vote_in_the_badge() -> None:
    """5M is structural detail. If it voted, the badge would start tracking the
    fast lane, which is the whole thing this layer exists to avoid."""
    with_5m = (synthetic("4H", "bullish"), synthetic("5M", "bearish"))
    assert aggregate_bias(with_5m, CFG) == aggregate_bias((synthetic("4H", "bullish"),), CFG)


def test_aggregation_is_symmetric() -> None:
    up = aggregate_bias((synthetic("4H", "bullish"), synthetic("1H", "bullish")), CFG)
    down = aggregate_bias((synthetic("4H", "bearish"), synthetic("1H", "bearish")), CFG)
    assert up[0] == "bullish" and down[0] == "bearish"
    assert up[1] == pytest.approx(-down[1])


# ── context caching + stability ──────────────────────────────────────────────


def test_the_first_build_adopts_whatever_it_reads() -> None:
    context = build_context("TST", (synthetic("4H", "bullish"),), T0, None, CFG)
    assert context.bias == "bullish"
    assert context.bias_since == T0


def test_one_disagreeing_refresh_does_not_flip_the_badge() -> None:
    bullish = (synthetic("4H", "bullish"), synthetic("1H", "bullish"))
    context = build_context("TST", bullish, T0, None, CFG)

    bearish = (synthetic("4H", "bearish", T0 + 60), synthetic("1H", "bearish", T0 + 60))
    challenged = build_context("TST", bearish, T0 + 60, context, CFG)
    assert challenged.bias == "bullish"
    assert challenged.pending_bias == "bearish"
    assert challenged.pending_count == 1
    assert challenged.bias_since == T0


def test_a_confirmed_change_does_flip_it() -> None:
    context = build_context("TST", (synthetic("4H", "bullish"),), T0, None, CFG)
    bearish = (synthetic("4H", "bearish", T0 + 60),)
    context = build_context("TST", bearish, T0 + 60, context, CFG)
    context = build_context("TST", bearish, T0 + 120, context, CFG)
    assert context.bias == "bearish"
    assert context.bias_since == T0 + 120
    assert context.pending_bias is None


def test_a_challenger_that_gives_up_is_forgotten() -> None:
    bullish = (synthetic("4H", "bullish"), synthetic("1H", "bullish"))
    context = build_context("TST", bullish, T0, None, CFG)
    bearish = (synthetic("4H", "bearish", T0 + 60), synthetic("1H", "bearish", T0 + 60))
    context = build_context("TST", bearish, T0 + 60, context, CFG)
    context = build_context("TST", bullish, T0 + 120, context, CFG)
    assert context.pending_bias is None
    assert context.pending_count == 0
    assert context.bias == "bullish"


def test_even_a_unanimous_reversal_waits_for_its_confirmation() -> None:
    """There is no decisiveness override: unanimity across two timeframes is an
    everyday reading, so letting it skip the queue would mean the badge never
    actually waits for anything."""
    context = build_context("TST", (synthetic("4H", "bullish"),), T0, None, CFG)
    unanimous = (
        synthetic("4H", "bearish", T0 + 60),
        synthetic("1H", "bearish", T0 + 60),
        synthetic("15M", "bearish", T0 + 60),
    )
    assert build_context("TST", unanimous, T0 + 60, context, CFG).bias == "bullish"


def test_more_confirmations_can_be_demanded() -> None:
    config = replace(CFG, flip_confirmations=3)
    context = build_context("TST", (synthetic("4H", "bullish"),), T0, None, config)
    bearish = (synthetic("4H", "bearish", T0 + 60),)
    for step in range(1, 3):
        context = build_context("TST", bearish, T0 + 60 * step, context, config)
        assert context.bias == "bullish"
    context = build_context("TST", bearish, T0 + 180, context, config)
    assert context.bias == "bearish"


def test_a_context_is_stale_only_once_every_read_has_aged_out() -> None:
    context = build_context(
        "TST", (synthetic("4H", "bullish", T0), synthetic("1H", "bullish", T0 + 3_000)), T0, None
    )
    assert context.is_stale(T0 + CFG.read_ttl_seconds + 10, CFG) is False
    assert context.is_stale(T0 + 3_000 + CFG.read_ttl_seconds + 10, CFG) is True


# ── alignment ────────────────────────────────────────────────────────────────


def bullish_context(now: float = T0) -> object:
    return build_context(
        "TST",
        (synthetic("4H", "bullish", now), synthetic("1H", "bullish", now)),
        now,
        None,
        CFG,
    )


def test_an_event_with_the_higher_timeframes_is_aligned() -> None:
    alignment = classify("bullish", bullish_context(), T0, CFG)  # type: ignore[arg-type]
    assert alignment.classification == "aligned"
    assert alignment.level == "HIGH"
    assert alignment.context_bias == "bullish"


def test_an_event_against_the_higher_timeframes_is_counter_trend() -> None:
    """A bearish burst inside a bullish regime. Classified, deliberately, as an
    observation — not as a short."""
    alignment = classify("bearish", bullish_context(), T0, CFG)  # type: ignore[arg-type]
    assert alignment.classification == "counter_trend"
    assert alignment.level == "COUNTER_TREND"


def test_alignment_is_symmetric() -> None:
    bearish = build_context(
        "TST", (synthetic("4H", "bearish"), synthetic("1H", "bearish")), T0, None, CFG
    )
    bull_in_bull = classify("bullish", bullish_context(), T0, CFG)  # type: ignore[arg-type]
    bear_in_bear = classify("bearish", bearish, T0, CFG)
    assert bull_in_bull.level == bear_in_bear.level
    assert bull_in_bull.classification == bear_in_bear.classification

    bear_in_bull = classify("bearish", bullish_context(), T0, CFG)  # type: ignore[arg-type]
    bull_in_bear = classify("bullish", bearish, T0, CFG)
    assert bear_in_bull.classification == bull_in_bear.classification == "counter_trend"


def test_unclear_context_stays_unclear() -> None:
    mixed = build_context(
        "TST", (synthetic("4H", "bullish"), synthetic("1H", "bearish")), T0, None, CFG
    )
    alignment = classify("bearish", mixed, T0, CFG)
    assert alignment.classification == "mixed"
    assert alignment.level == "MIXED"


def test_moderate_alignment_when_the_timeframes_only_partly_agree() -> None:
    partial = build_context(
        "TST",
        (synthetic("4H", "bullish"), synthetic("1H", "neutral"), synthetic("15M", "neutral")),
        T0,
        None,
        CFG,
    )
    alignment = classify("bullish", partial, T0, CFG)
    assert alignment.classification == "aligned"
    assert alignment.level == "MODERATE"


def test_missing_or_stale_context_is_unknown_never_invented() -> None:
    assert classify("bullish", None, T0, CFG).level == "UNKNOWN"
    stale = bullish_context()
    assert classify("bullish", stale, T0 + CFG.read_ttl_seconds + 10, CFG).level == "UNKNOWN"  # type: ignore[arg-type]


def test_a_direction_less_event_reports_context_without_agreeing_with_it() -> None:
    alignment = classify(None, bullish_context(), T0, CFG)  # type: ignore[arg-type]
    assert alignment.classification == "unclassified"
    assert alignment.context_bias == "bullish"


# ── 1m micro structure ───────────────────────────────────────────────────────


def minute_candles(**kwargs: object) -> list[Candle]:
    return wave(step=60, **kwargs)  # type: ignore[arg-type]


def test_micro_structure_reads_the_1m_trend() -> None:
    result = read_micro_structure(minute_candles(count=60, drift=0.05))
    assert result is not None
    assert result.trend == "uptrend"
    assert result.bars == 60


def test_micro_structure_stays_silent_on_too_little_tape() -> None:
    assert read_micro_structure(minute_candles(count=10)) is None


def test_the_same_break_is_only_reported_once() -> None:
    """Identity is the swing that produced the break, so re-reading it on the
    next tick must not mint a second event."""
    candles = minute_candles(count=80, drift=0.05)
    first = read_micro_structure(candles)
    again = read_micro_structure(candles)
    assert is_new_break(None, first) == (first is not None and first.event == "choch")
    assert is_new_break(first, again) is False


def test_a_read_without_a_break_is_not_an_event() -> None:
    flat = read_micro_structure(minute_candles(count=60, drift=0.0, amplitude=0.0))
    assert is_new_break(None, flat) is False
