"""Port of zones.test.ts — characterization of compute_base_zones.

Pins the TS engine's exact output on the Dreimann ground-truth set. These are
not aspirational assertions: a legitimate behavior change must bump
ENGINE_VERSION and re-record the pins deliberately.
"""

import pytest

from smc.mock_candles import TokenTimeframe, generate_mock_candles
from smc.types import Candle
from smc.zones import BaseZone, compute_base_zones
from tests.dreimann import DREIMANN_TRADES, label_time, load_dreimann_fixture


def dreimann_context(name: str) -> list[Candle]:
    fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
    entry_time = label_time(fixture.labels.entry.approx_time_utc)
    return [c for c in fixture.series["4h"] if c.time <= entry_time]


def test_finds_no_bases_on_smooth_synthetic_tape() -> None:
    # Mock candles never produce a departure body >= 1.15x ATR with >= 55% body
    # share; pinning the empty result guards the gate's calibration.
    timeframes: tuple[TokenTimeframe, ...] = ("1H", "4H", "1D")
    for symbol in ("BTC", "ETH", "SOL"):
        for tf in timeframes:
            assert compute_base_zones(generate_mock_candles(symbol, tf, 360)) == []


def test_pins_the_exact_zec_sl_4h_zones_as_of_entry() -> None:
    assert compute_base_zones(dreimann_context("zec-sl")) == [
        BaseZone(
            kind="demand",
            price_low=418.2,
            price_high=425.92,
            start_time=1782964800,
            end_time=1782979200,
            freshness="tested",
        ),
        BaseZone(
            kind="supply",
            price_low=455.5765714285714,
            price_high=457.44,
            start_time=1783310400,
            end_time=1783324800,
            freshness="tested",
        ),
    ]


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("zec-tp", [("demand", 418.2, 425.92, "tested")]),
        ("trx-tp3", [("demand", 0.31996, 0.32108, "fresh")]),
        ("ethfi-sl", [("demand", 0.3169, 0.3197, "fresh")]),
        ("jup-tp", []),
        ("fet-tp", [("supply", 0.1884, 0.1896, "tested")]),
    ],
)
def test_pins_the_4h_zone_set_as_of_entry(
    name: str, expected: list[tuple[str, float, float, str]]
) -> None:
    zones = compute_base_zones(dreimann_context(name))
    assert len(zones) == len(expected)
    for zone, (kind, price_low, price_high, freshness) in zip(zones, expected, strict=True):
        assert zone.kind == kind
        assert zone.price_low == price_low
        assert zone.price_high == price_high
        assert zone.freshness == freshness


@pytest.mark.parametrize("name", DREIMANN_TRADES)
def test_structural_invariants_hold_over_every_prefix_window(name: str) -> None:
    context = dreimann_context(name)
    for n in range(30, len(context) + 1, 25):
        zones = compute_base_zones(context[:n])
        # Determinism.
        assert compute_base_zones(context[:n]) == zones
        # At most 2 per kind, chronological, well-formed bounds, valid freshness.
        assert sum(1 for z in zones if z.kind == "demand") <= 2
        assert sum(1 for z in zones if z.kind == "supply") <= 2
        for i, z in enumerate(zones):
            assert z.price_low < z.price_high
            assert z.start_time <= z.end_time
            assert z.freshness in ("fresh", "tested")
            if i > 0:
                assert z.start_time >= zones[i - 1].start_time
            # No same-kind overlap survives selection.
            for other in zones[i + 1 :]:
                if other.kind != z.kind:
                    continue
                assert z.price_low > other.price_high or z.price_high < other.price_low
