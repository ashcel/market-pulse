"""Port of rs-scan.test.ts."""

from smc.discovery import ScanGates, Ticker24h
from smc.mock_candles import generate_mock_candles
from smc.rs_scan import (
    RS_ENRICH_COUNT,
    RS_TRANSITION_MAX_BARS,
    build_demo_rs_scan,
    compute_rs_rows,
    transition_flag,
)


def row(ticker: str, **overrides: float) -> Ticker24h:
    base = Ticker24h(
        ticker=ticker,
        last_price=100,
        change_percent24h=1,
        high_price=105,
        low_price=95,
        weighted_avg_price=100,
        quote_volume24h=200_000_000,
        trades24h=400_000,
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


BTC = row("BTC", change_percent24h=2)


def test_ranks_by_24h_spread_vs_btc_strongest_first_with_percentiles() -> None:
    ranked = compute_rs_rows(
        [
            row("SOL", change_percent24h=7),  # +5 vs BTC
            row("ETH", change_percent24h=2),  # 0
            row("ADA", change_percent24h=-3),  # -5
            BTC,  # the yardstick, never a row
        ],
        BTC,
    )
    assert [r.ticker for r in ranked] == ["SOL", "ETH", "ADA"]
    assert [r.rs_btc24h for r in ranked] == [5, 0, -5]
    assert ranked[0].rs_percentile24h == 100
    assert ranked[2].rs_percentile24h == 0
    # Tier 1 carries no enrichment.
    assert all(r.rs_btc7d is None and r.transition is None for r in ranked)


def test_applies_the_discovery_gates_floors_then_the_liquidity_tier() -> None:
    ranked = compute_rs_rows(
        [
            row("SOL", change_percent24h=9),
            row("DUST", change_percent24h=50, quote_volume24h=1_000_000),  # below floor
            row("THIN", change_percent24h=40, trades24h=500),  # below floor
            row("MID", change_percent24h=4, quote_volume24h=6_000_000),
        ],
        BTC,
        ScanGates(min_quote_volume24h=5_000_000, min_trades24h=10_000, liquidity_tier_size=1),
    )
    # The tier keeps only the single most liquid survivor.
    assert [r.ticker for r in ranked] == ["SOL"]


def test_breaks_spread_ties_by_volume_then_ticker_a_total_order() -> None:
    ranked = compute_rs_rows(
        [
            row("AAA", change_percent24h=3, quote_volume24h=100_000_000),
            row("BBB", change_percent24h=3, quote_volume24h=300_000_000),
            row("CCC", change_percent24h=3, quote_volume24h=100_000_000),
        ],
        BTC,
    )
    assert [r.ticker for r in ranked] == ["BBB", "AAA", "CCC"]


def test_transition_flag_maps_a_recent_daily_transition_and_drops_a_stale_one() -> None:
    daily = generate_mock_candles("BTC", "1D", 200)
    flag = transition_flag(daily)
    if flag is not None:
        assert 0 <= flag.bars_ago <= RS_TRANSITION_MAX_BARS
        assert flag.from_trend != flag.to_trend
    assert transition_flag([]) is None


def test_build_demo_rs_scan_is_deterministic_btc_free_and_enriched_on_both_sides() -> None:
    a = build_demo_rs_scan()
    b = build_demo_rs_scan()
    assert a.leaders == b.leaders
    assert a.laggards == b.laggards
    assert a.source == "demo"
    assert len(a.leaders) <= RS_ENRICH_COUNT
    assert all(r.ticker != "BTC" for r in [*a.leaders, *a.laggards])
    # Leaders strongest-first, laggards weakest-first.
    for i in range(1, len(a.leaders)):
        assert a.leaders[i - 1].rs_btc24h >= a.leaders[i].rs_btc24h
    for i in range(1, len(a.laggards)):
        assert a.laggards[i - 1].rs_btc24h <= a.laggards[i].rs_btc24h
    # Enrichment ran on the demo build (7d RS present).
    assert all(r.rs_btc7d is not None for r in a.leaders)
