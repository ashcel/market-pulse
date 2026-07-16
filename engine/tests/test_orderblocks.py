"""Port of orderblocks.test.ts."""

import pytest

from smc.orderblocks import (
    OrderBlock,
    OrderBlockKind,
    detect_order_blocks,
    select_order_blocks,
)
from smc.types import Candle
from tests.dreimann import DREIMANN_TRADES, label_time, load_dreimann_fixture


def candle(time: int, open_: float, high: float, low: float, close: float) -> Candle:
    return Candle(time=time, open=open_, high=high, low=low, close=close, volume=1_000)


def flat_run(count: int, price: float = 100, start_time: int = 0) -> list[Candle]:
    """A flat run of unit-range candles so ATR14 settles near 1."""
    return [candle(start_time + i, price, price + 0.5, price - 0.5, price) for i in range(count)]


BASE = flat_run(30)
T = len(BASE)  # next free bar time


class TestDetectOrderBlocks:
    def test_finds_the_last_down_candle_before_an_up_displacement_as_demand_ob(self) -> None:
        blocks = detect_order_blocks(
            [
                *BASE,
                candle(T, 100.3, 100.5, 99.6, 99.7),  # opposing (down) candle — the OB
                candle(T + 1, 99.7, 101.3, 99.6, 101.2),  # displacement
            ]
        )
        assert len(blocks) == 1
        b = blocks[0]
        assert b.kind == "demand"
        assert b.price_low == 99.6
        assert b.price_high == 100.5
        assert b.time == T
        assert b.displacement_time == T + 1
        assert b.swept_swing is False
        assert b.displacement_atr >= 1.15

    def test_mirrors_for_supply(self) -> None:
        blocks = detect_order_blocks(
            [
                *BASE,
                candle(T, 99.7, 100.4, 99.5, 100.3),  # opposing (up) candle
                candle(T + 1, 100.3, 100.4, 98.7, 98.8),  # bearish displacement
            ]
        )
        assert len(blocks) == 1
        assert blocks[0].kind == "supply"
        assert blocks[0].time == T
        assert blocks[0].price_high == 100.4

    def test_requires_displacement_conviction(self) -> None:
        # Body 0.8 < 1.15x ATR: no OB.
        weak = detect_order_blocks(
            [
                *BASE,
                candle(T, 100.3, 100.5, 99.6, 99.7),
                candle(T + 1, 99.7, 100.6, 99.6, 100.5),
            ]
        )
        assert weak == []
        # Body 1.5 but range 3.5 (43% share): mostly wick, no OB.
        wicky = detect_order_blocks(
            [
                *BASE,
                candle(T, 100.3, 100.5, 99.6, 99.7),
                candle(T + 1, 99.7, 103.1, 99.6, 101.2),
            ]
        )
        assert wicky == []

    def test_walks_back_over_indecision_dojis_to_the_opposing_candle(self) -> None:
        blocks = detect_order_blocks(
            [
                *BASE,
                candle(T, 100.3, 100.5, 99.6, 99.7),  # the OB, two dojis later
                candle(T + 1, 99.7, 100.1, 99.5, 99.9),  # doji (body 0.2, up-close — skippable)
                candle(T + 2, 99.9, 100.3, 99.7, 100.1),  # doji
                candle(T + 3, 100.1, 101.7, 100.0, 101.6),  # displacement
            ]
        )
        assert len(blocks) == 1
        assert blocks[0].time == T

    def test_aborts_when_a_same_direction_conviction_candle_precedes(self) -> None:
        blocks = detect_order_blocks(
            [
                *BASE,
                candle(T, 100.3, 100.5, 99.6, 99.7),
                candle(T + 1, 99.7, 100.6, 99.6, 100.4),  # up-close body 0.7 > 0.45x ATR
                candle(T + 2, 100.4, 102.0, 100.3, 101.9),  # displacement
            ]
        )
        assert blocks == []

    def test_flags_a_sweep_origin_ob(self) -> None:
        blocks = detect_order_blocks(
            [
                *BASE,  # prior lows all 99.5
                candle(T, 100.3, 100.5, 99.2, 99.7),  # OB wick to 99.2 — below every prior low
                candle(T + 1, 99.7, 101.3, 99.6, 101.2),
            ]
        )
        assert len(blocks) == 1
        assert blocks[0].swept_swing is True

    def test_is_deterministic_and_prefix_replay_safe_on_real_fixture_data(self) -> None:
        for name in ("zec-sl", "fet-tp"):
            series = load_dreimann_fixture(name).series["4h"]
            full = detect_order_blocks(series)
            assert detect_order_blocks(series) == full
            for n in range(30, len(series) + 1, 25):
                window = series[:n]
                cutoff = window[-1].time
                assert detect_order_blocks(window) == [
                    b for b in full if b.displacement_time <= cutoff
                ]


def make_block(
    kind: OrderBlockKind,
    price_low: float,
    price_high: float,
    displacement_time: int,
    displacement_atr: float = 1.5,
) -> OrderBlock:
    return OrderBlock(
        kind=kind,
        price_low=price_low,
        price_high=price_high,
        time=displacement_time - 1,
        displacement_time=displacement_time,
        displacement_atr=displacement_atr,
        swept_swing=False,
    )


class TestSelectOrderBlocks:
    def test_ranks_most_recent_first_caps_at_2_per_kind_drops_overlap(self) -> None:
        picked = select_order_blocks(
            [
                make_block("demand", 10, 11, 1),
                make_block("demand", 20, 21, 2),
                make_block("demand", 30, 31, 3),
                make_block("demand", 30.5, 32, 4),  # overlaps the previous — newer wins
                make_block("supply", 50, 51, 5),
            ]
        )
        assert picked[0].displacement_time == 5
        demands = [b for b in picked if b.kind == "demand"]
        assert len(demands) == 2
        assert [b.displacement_time for b in demands] == [4, 2]  # 3 lost to overlap, 1 to cap


class TestDreimannAnnotationFidelity:
    @pytest.mark.parametrize("name", DREIMANN_TRADES)
    def test_ob_reads_as_of_entry_are_structurally_coherent(self, name: str) -> None:
        fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
        entry_time = label_time(fixture.labels.entry.approx_time_utc)
        context = [c for c in fixture.series["4h"] if c.time <= entry_time]
        # Availability per fixture is a finding recorded in EDR 0013; here only
        # structure is asserted so a data refresh can't silently flip a verdict.
        for b in detect_order_blocks(context):
            assert b.price_low < b.price_high
            assert b.time < b.displacement_time
            assert b.displacement_atr >= 1.15
