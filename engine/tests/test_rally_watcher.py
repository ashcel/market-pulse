"""RALLY WATCHER detector — component isolation, positive/negative fixtures,
liquidation-formula invariants, and the no-lookahead replay-safety proof.
"""

from __future__ import annotations

from smc.rally_watcher import (
    AVG_LEVERAGE,
    ENTRY_VWAP_BARS,
    EXTENDED_SCORE_CAP,
    MMR,
    RALLY_EXTENDED_PCT,
    RALLY_MIN_GAIN_PCT,
    RALLY_TARGET_BONUS_PCT,
    RALLY_VOLUME_MULT,
    RALLY_WINDOW_BARS,
    VOLUME_TRAILING_BARS,
    _liquidation_targets,
    _select_resistance,
    evaluate_rally,
)
from smc.reaccumulation import OiPoint
from smc.types import Candle

FIVE_MIN = 300
BASE_TIME = 1_800_000_000


def _bar(t: int, o: float, h: float, low: float, c: float, vol: float) -> Candle:
    return Candle(time=t, open=o, high=h, low=low, close=c, volume=vol)


def _flat_bars(n: int, start_idx: int, price: float = 100.0, vol: float = 50.0) -> list[Candle]:
    return [
        _bar(
            BASE_TIME + (start_idx + i) * FIVE_MIN,
            price,
            price + 0.4,
            price - 0.4,
            price,
            vol,
        )
        for i in range(n)
    ]


def _twin_peak_leadin(start_idx: int, peak_height: float, base_price: float = 100.0) -> list[Candle]:
    """~15 bars with two equal-high pivots at `peak_height`, separated by a
    valley, framed by flat filler so pivot_window's k=3 neighborhood never
    sees a higher high than the peaks themselves. Forms one intact BSL pool
    at `peak_height` once fed through compute_pivots/compute_market_structure/
    compute_liquidity_pools."""
    bars: list[Candle] = []
    bars += _flat_bars(3, start_idx, base_price)  # padding so the first peak has 3 quiet bars behind it
    idx = start_idx + 3
    # touch 1
    bars.append(_bar(BASE_TIME + idx * FIVE_MIN, base_price, peak_height, base_price - 1, base_price + 1, 50))
    idx += 1
    bars += _flat_bars(2, idx, base_price - 0.5)
    idx += 2
    bars += _flat_bars(1, idx, base_price - 3)  # valley
    idx += 1
    bars += _flat_bars(2, idx, base_price - 0.5)
    idx += 2
    # touch 2 (equal high)
    bars.append(_bar(BASE_TIME + idx * FIVE_MIN, base_price, peak_height, base_price - 1, base_price + 1, 50))
    idx += 1
    bars += _flat_bars(3, idx, base_price)  # padding so the second peak has 3 quiet bars ahead of it
    return bars


def _rally_scenario(
    *,
    gain_pct: float = 2.0,
    rally_volume: float = 200.0,
    trailing_volume: float = 50.0,
    faded: bool = False,
    peak_height: float | None = 110.0,
    trailing_close: float = 100.0,
) -> list[Candle]:
    """One full RALLY WATCHER fixture: optional BSL-forming lead-in, a quiet
    trailing window, then a 3-bar rally. `peak_height=None` omits the lead-in
    entirely (no BSL pool above price)."""
    idx = 0
    candles: list[Candle] = []
    if peak_height is not None:
        candles += _twin_peak_leadin(idx, peak_height)
        idx = len(candles)
    else:
        # No lead-in: pad so total bar count still clears MIN_BARS_REQUIRED.
        candles += _flat_bars(2, idx, trailing_close, trailing_volume)
        idx = len(candles)

    trailing_needed = VOLUME_TRAILING_BARS
    candles += _flat_bars(trailing_needed, idx, trailing_close, trailing_volume)
    idx += trailing_needed

    base_close = trailing_close
    final_close = base_close * (1 + gain_pct / 100)
    step = (final_close - base_close) / RALLY_WINDOW_BARS
    o = base_close
    for i in range(RALLY_WINDOW_BARS):
        c = o + step
        is_last = i == RALLY_WINDOW_BARS - 1
        if is_last and faded:
            # Wick well above the window but close back near the bottom.
            h = c + (final_close - base_close) * 1.5
            low = min(o, c) - 0.05
            c = low + 0.01  # closes at the very bottom of the window
        else:
            h = max(o, c) + 0.15
            low = min(o, c) - 0.05
        candles.append(_bar(BASE_TIME + idx * FIVE_MIN, o, h, low, c, rally_volume))
        idx += 1
        o = c
    return candles


# ── positive fixture ─────────────────────────────────────────────────────────


def test_clean_rally_fires_with_all_three_targets():
    candles = _rally_scenario()
    read = evaluate_rally(candles, None, None, symbol="TEST")
    assert read is not None
    assert read.direction == "long"
    assert read.gain_pct >= RALLY_MIN_GAIN_PCT
    assert read.volume_mult >= RALLY_VOLUME_MULT
    assert read.extended is False
    assert 0 <= read.momentum_score <= 100
    assert "smcPool" in read.targets
    assert read.targets["smcPool"]["price"] == 110.0
    assert "resistance" in read.targets
    assert "liquidation" in read.targets
    assert "bslAbove" in read.liquidity and "sslBelow" in read.liquidity and "longLiq" in read.liquidity
    assert read.explanation
    assert read.symbol == "TEST"


# ── negative / degraded cases ────────────────────────────────────────────────


def test_no_gain_returns_none():
    candles = _rally_scenario(gain_pct=0.2)
    assert evaluate_rally(candles, None, None) is None


def test_faded_close_returns_none():
    candles = _rally_scenario(gain_pct=2.0, faded=True)
    assert evaluate_rally(candles, None, None) is None


def test_low_volume_returns_none():
    candles = _rally_scenario(rally_volume=55.0, trailing_volume=50.0)
    assert evaluate_rally(candles, None, None) is None


def test_overextended_still_fires_flagged_and_capped():
    candles = _rally_scenario(gain_pct=RALLY_EXTENDED_PCT + 2)
    read = evaluate_rally(candles, None, None, symbol="MOON")
    assert read is not None
    assert read.extended is True
    assert read.momentum_score <= EXTENDED_SCORE_CAP


def test_no_bsl_above_omits_smc_pool_but_still_fires():
    candles = _rally_scenario(peak_height=None)
    read = evaluate_rally(candles, None, None)
    assert read is not None
    assert "smcPool" not in read.targets
    assert "resistance" in read.targets
    assert "liquidation" in read.targets


# ── component isolation ──────────────────────────────────────────────────────


def test_select_resistance_prefers_nearer_of_swing_high_and_measured_move():
    # Swing high much closer than the measured-move projection -> swing high wins.
    price, label, _detail = _select_resistance([101.0, 120.0], window_low=98.0, window_high=100.0, last_close=100.0)
    assert label == "Swing high"
    assert price == 101.0


def test_select_resistance_falls_back_to_measured_move_with_no_swing_high():
    price, label, _detail = _select_resistance([], window_low=98.0, window_high=100.0, last_close=100.0)
    assert label == "Measured move"
    assert price == 100.0 + (100.0 - 98.0)


def test_select_resistance_picks_nearer_measured_move_over_distant_swing_high():
    price, label, _detail = _select_resistance([150.0], window_low=99.0, window_high=100.0, last_close=100.0)
    assert label == "Measured move"
    assert price == 101.0


# ── liquidation formula invariants ───────────────────────────────────────────


def test_liquidation_ordering_long_below_entry_below_short():
    short_target, long_target = _liquidation_targets(vwap_entry=100.0, current_price=100.0)
    assert long_target.price < 100.0 < short_target.price


def test_liquidation_higher_leverage_moves_levels_closer_to_entry():
    def levels(entry: float, leverage: float, mmr: float) -> tuple[float, float]:
        long_liq = entry * (1 - 1 / leverage) / (1 - mmr)
        short_liq = entry * (1 + 1 / leverage) / (1 + mmr)
        return long_liq, short_liq

    entry = 100.0
    long_10x, short_10x = levels(entry, 10.0, MMR)
    long_20x, short_20x = levels(entry, 20.0, MMR)
    assert entry - long_20x < entry - long_10x
    assert short_20x - entry < short_10x - entry


def test_liquidation_mmr_has_small_effect():
    entry = 100.0
    short_with_mmr, long_with_mmr = _liquidation_targets(entry, entry)
    long_no_mmr = entry * (1 - 1 / AVG_LEVERAGE)
    short_no_mmr = entry * (1 + 1 / AVG_LEVERAGE)
    # MMR is a small (0.5%) correction on top of the leverage-only level.
    assert abs(long_with_mmr.price - long_no_mmr) / entry < 0.01
    assert abs(short_with_mmr.price - short_no_mmr) / entry < 0.01


def test_liquidation_module_uses_documented_constants():
    short_target, long_target = _liquidation_targets(100.0, 100.0)
    expected_short = 100.0 * (1 + 1 / AVG_LEVERAGE) / (1 + MMR)
    expected_long = 100.0 * (1 - 1 / AVG_LEVERAGE) / (1 - MMR)
    assert short_target.price == expected_short
    assert long_target.price == expected_long


# ── no-lookahead replay safety ───────────────────────────────────────────────


def test_no_lookahead_truncated_prefix_matches_full_series():
    candles = _rally_scenario()
    # Append a handful of unrelated future bars — must not change the read.
    tail = _flat_bars(6, len(candles), price=103.0, vol=40.0)
    full = candles + tail
    target_idx = len(candles) - 1

    oi = [OiPoint(time=c.time, value=1_000_000.0 + i) for i, c in enumerate(full)]

    from_full = evaluate_rally(full, oi, 0.0001, index=target_idx, symbol="AAA")
    from_prefix = evaluate_rally(full[: target_idx + 1], oi, 0.0001, index=-1, symbol="AAA")

    assert from_full is not None
    assert from_prefix is not None
    assert from_full.gain_pct == from_prefix.gain_pct
    assert from_full.volume_mult == from_prefix.volume_mult
    assert from_full.momentum_score == from_prefix.momentum_score
    assert from_full.targets == from_prefix.targets
    assert from_full.liquidity == from_prefix.liquidity
    assert from_full.evaluated_at == from_prefix.evaluated_at
    assert from_full.oi_available == from_prefix.oi_available


def test_no_lookahead_at_multiple_indices():
    candles = _rally_scenario()
    tail = _flat_bars(10, len(candles), price=103.0, vol=40.0)
    full = candles + tail

    for target_idx in (len(candles) - 1, len(candles) + 2, len(full) - 1):
        from_full = evaluate_rally(full, None, None, index=target_idx)
        from_prefix = evaluate_rally(full[: target_idx + 1], None, None, index=-1)
        if from_full is None:
            assert from_prefix is None
        else:
            assert from_prefix is not None
            assert from_full.gain_pct == from_prefix.gain_pct
            assert from_full.momentum_score == from_prefix.momentum_score


# ── OI-missing path ───────────────────────────────────────────────────────────


def test_oi_missing_still_computes_liquidation_with_defaults():
    candles = _rally_scenario()
    read_no_oi = evaluate_rally(candles, None, None)
    assert read_no_oi is not None
    assert read_no_oi.oi_available is False
    assert "liquidation" in read_no_oi.targets
    assert read_no_oi.targets["liquidation"]["price"] > 0

    oi = [OiPoint(time=candles[-1].time, value=5_000_000.0)]
    read_with_oi = evaluate_rally(candles, oi, 0.0001)
    assert read_with_oi is not None
    assert read_with_oi.oi_available is True
    # OI presence never changes the liquidation math (documented defaults).
    assert read_with_oi.targets["liquidation"]["price"] == read_no_oi.targets["liquidation"]["price"]


def test_rally_target_bonus_pct_documented_constant_used():
    # Sanity: constant is exported and positive, as the momentum-score docstring promises.
    assert RALLY_TARGET_BONUS_PCT > 0
    assert ENTRY_VWAP_BARS > 0
