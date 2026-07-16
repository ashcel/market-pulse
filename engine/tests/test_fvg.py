"""Port of fvg.test.ts."""

import math

from smc.fvg import MIN_FVG_SIZE_ATR, Fvg, FvgKind, detect_fvgs, select_fvgs
from smc.mock_candles import generate_mock_candles
from smc.types import Candle
from smc.zones import atr_series


def candle(time: int, open_: float, high: float, low: float, close: float) -> Candle:
    return Candle(time=time, open=open_, high=high, low=low, close=close, volume=1_000)


def flat_run(count: int, price: float, range_: float = 1, start_time: int = 0) -> list[Candle]:
    """A flat run of unit-range candles so ATR14 settles near range."""
    return [
        candle(start_time + i, price, price + range_ / 2, price - range_ / 2, price)
        for i in range(count)
    ]


class TestDetectFvgs:
    def test_finds_a_bullish_3_candle_imbalance(self) -> None:
        fvgs = detect_fvgs(
            [
                candle(1, 99, 100, 98, 99.5),
                candle(2, 99.5, 106, 99, 105.5),
                candle(3, 105.5, 107, 104, 106),
            ]
        )
        assert len(fvgs) == 1
        f = fvgs[0]
        assert f.kind == "bullish"
        assert f.gap_low == 100
        assert f.gap_high == 104
        assert f.time == 2
        assert f.confirm_time == 3
        assert f.size_atr is None  # no ATR14 this early — recorded honestly, not guessed
        assert math.isclose(f.size_pct, (4 / 102) * 100, abs_tol=1e-6)

    def test_mirrors_for_bearish(self) -> None:
        fvgs = detect_fvgs(
            [
                candle(1, 101, 102, 100, 100.5),
                candle(2, 100.5, 101, 94, 94.5),
                candle(3, 94.5, 96, 93, 95),
            ]
        )
        assert len(fvgs) == 1
        f = fvgs[0]
        assert (f.kind, f.gap_low, f.gap_high, f.time) == ("bearish", 96, 100, 2)

    def test_emits_nothing_when_the_third_candle_only_touches_the_first(self) -> None:
        touching = detect_fvgs(
            [
                candle(1, 99, 100, 98, 99.5),
                candle(2, 99.5, 106, 99, 105.5),
                candle(3, 105.5, 107, 100, 106),  # low == high[i-2]
            ]
        )
        assert touching == []

    def test_applies_the_g7_size_floor_once_atr_is_measurable(self) -> None:
        run = flat_run(20, 100)  # ATR14 ~ 1
        last = run[-1]
        # Tiny gap ~ 0.1x ATR — below MIN_FVG_SIZE_ATR, dropped.
        tiny = [
            *run,
            candle(last.time + 1, 100, 101.2, 100.1, 101.1),
            candle(last.time + 2, 101.1, 101.4, 100.6, 101.2),
        ]
        assert [f for f in detect_fvgs(tiny) if f.confirm_time > last.time] == []

        # Wide gap ~ 2x ATR — kept, with the normalized size recorded.
        wide = [
            *run,
            candle(last.time + 1, 100, 105, 100.2, 104.8),
            candle(last.time + 2, 104.8, 105.5, 102.5, 105),
        ]
        found = [f for f in detect_fvgs(wide) if f.confirm_time > last.time]
        assert len(found) == 1
        assert found[0].size_atr is not None
        assert found[0].size_atr >= MIN_FVG_SIZE_ATR
        # The yardstick predates the displacement: gap / ATR-as-of-the-shelf.
        atr = atr_series(wide)
        ref = atr[len(wide) - 3]
        assert ref is not None
        assert math.isclose(found[0].size_atr, (102.5 - 100.5) / ref, abs_tol=1e-6)

    def test_is_deterministic_and_prefix_replay_safe(self) -> None:
        for symbol in ("BTC", "ETH", "SOL"):
            candles = generate_mock_candles(symbol, "4H", 360)
            full = detect_fvgs(candles)
            assert detect_fvgs(candles) == full
            for n in range(30, len(candles) + 1, 30):
                window = candles[:n]
                cutoff = window[-1].time
                assert detect_fvgs(window) == [f for f in full if f.confirm_time <= cutoff]


def make_fvg(kind: FvgKind, gap_low: float, gap_high: float, confirm_time: int) -> Fvg:
    return Fvg(
        kind=kind,
        gap_low=gap_low,
        gap_high=gap_high,
        time=confirm_time - 1,
        confirm_time=confirm_time,
        size_atr=1,
        size_pct=1,
    )


class TestSelectFvgs:
    def test_ranks_most_recent_first_and_caps_per_kind(self) -> None:
        picked = select_fvgs(
            [
                make_fvg("bullish", 10, 11, 1),
                make_fvg("bullish", 20, 21, 2),
                make_fvg("bullish", 30, 31, 3),
                make_fvg("bullish", 40, 41, 4),
                make_fvg("bearish", 50, 51, 5),
            ]
        )
        assert picked[0].confirm_time == 5
        assert len([f for f in picked if f.kind == "bullish"]) == 3
        assert not any(f.confirm_time == 1 for f in picked)  # oldest bullish overflow dropped

    def test_drops_overlapping_same_kind_duplicates_keeping_the_most_recent(self) -> None:
        picked = select_fvgs([make_fvg("bullish", 10, 12, 1), make_fvg("bullish", 11, 13, 2)])
        assert len(picked) == 1
        assert picked[0].confirm_time == 2
        # Opposite kinds may overlap — both kept.
        assert (
            len(select_fvgs([make_fvg("bullish", 10, 12, 1), make_fvg("bearish", 11, 13, 2)])) == 2
        )
