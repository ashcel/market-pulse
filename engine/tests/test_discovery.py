"""Port of discovery.test.ts."""

import re

from smc.discovery import (
    DEFAULT_GATES,
    MarketOpportunity,
    Ticker24h,
    build_demo_scan,
    parse_ticker24h_all,
    scan_spikes,
    score_opportunities,
)
from smc.spike import REF_WINDOW
from smc.types import Candle


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


def raw_ticker(symbol: str, **overrides: object) -> dict[str, object]:
    return {
        "symbol": symbol,
        "lastPrice": "100",
        "priceChangePercent": "2.5",
        "highPrice": "104",
        "lowPrice": "96",
        "weightedAvgPrice": "100",
        "quoteVolume": "150000000",
        "count": 500_000,
        **overrides,
    }


def test_parse_keeps_only_well_formed_usdt_pairs() -> None:
    rows = parse_ticker24h_all(
        [
            raw_ticker("SOLUSDT"),
            raw_ticker("SOLBTC"),  # non-USDT quote
            raw_ticker("ETHUSDC"),  # non-USDT quote
            raw_ticker("ADAUSDT", lastPrice="not-a-number"),  # malformed
            {"symbol": "XRPUSDT"},  # missing fields
            "garbage",
            None,
        ]
    )
    assert [r.ticker for r in rows] == ["SOL"]
    assert rows[0].last_price == 100
    assert rows[0].quote_volume24h == 150_000_000


def test_parse_excludes_stable_fiat_wrapped_and_leveraged_bases() -> None:
    rows = parse_ticker24h_all(
        [
            raw_ticker("USDCUSDT"),
            raw_ticker("FDUSDUSDT"),
            raw_ticker("EURUSDT"),
            raw_ticker("WBTCUSDT"),
            raw_ticker("PAXGUSDT"),
            raw_ticker("BTCUPUSDT"),
            raw_ticker("ETHDOWNUSDT"),
            raw_ticker("EOSBULLUSDT"),
        ]
    )
    assert rows == []


def test_parse_does_not_mistake_real_tickers_ending_in_up_for_leveraged_tokens() -> None:
    rows = parse_ticker24h_all([raw_ticker("JUPUSDT")])
    assert [r.ticker for r in rows] == ["JUP"]


def test_parse_returns_empty_for_non_list_payloads() -> None:
    assert parse_ticker24h_all({"code": -1}) == []
    assert parse_ticker24h_all(None) == []


def test_gates_drop_sub_floor_pairs_entirely_no_matter_how_volatile() -> None:
    thin = row(
        "THIN",
        quote_volume24h=DEFAULT_GATES.min_quote_volume24h - 1,
        high_price=160,
        low_price=80,  # 80% range
    )
    low_trades = row(
        "WASH",
        trades24h=DEFAULT_GATES.min_trades24h - 1,
        high_price=160,
        low_price=80,
    )
    ranked = score_opportunities([thin, low_trades, row("OK")])
    assert [o.ticker for o in ranked] == ["OK"]


def test_gates_rank_only_the_top_liquidity_tier() -> None:
    rows = [
        row(
            f"T{i}",
            # T0 is the most liquid, each subsequent pair a step thinner.
            quote_volume24h=2_000_000_000 - i * 15_000_000,
            # The thinnest pair is also the wildest — tier cut must still exclude it.
            high_price=100 + i * 0.5,
            low_price=95,
        )
        for i in range(DEFAULT_GATES.liquidity_tier_size + 20)
    ]
    ranked = score_opportunities(rows)
    assert len(ranked) == DEFAULT_GATES.liquidity_tier_size
    tickers = {o.ticker for o in ranked}
    assert f"T{DEFAULT_GATES.liquidity_tier_size}" not in tickers
    assert "T0" in tickers


def test_does_not_let_barely_liquid_volatility_beat_deep_liquidity_movement() -> None:
    # A pair barely above the liquidity floor with an extreme range must not
    # outrank a deep, active pair in a genuine (smaller) expansion.
    rows = [
        row(
            "THIN",
            quote_volume24h=DEFAULT_GATES.min_quote_volume24h + 1_000_000,
            trades24h=DEFAULT_GATES.min_trades24h + 5_000,
            high_price=230,
            low_price=100,  # ~80% range — scan-wide max volatility by far
        ),
        row(
            "SOLID",
            quote_volume24h=900_000_000,
            trades24h=2_000_000,
            high_price=112,
            low_price=100,  # ~12% range — elevated but not extreme
        ),
        # Quiet liquid filler so percentiles have a real distribution.
        *(
            row(
                f"F{i}",
                quote_volume24h=60_000_000 + i * 10_000_000,
                trades24h=120_000 + i * 10_000,
                high_price=102 + i * 0.1,
                low_price=99,
            )
            for i in range(8)
        ),
    ]
    ranked = score_opportunities(rows)
    order = [o.ticker for o in ranked]
    assert order.index("SOLID") < order.index("THIN")
    assert order[0] == "SOLID"


def test_is_deterministic_and_returns_the_full_ranked_list_best_first() -> None:
    rows = [
        row(
            f"T{i}",
            quote_volume24h=30_000_000 + i * 47_000_000,
            trades24h=40_000 + i * 91_000,
            high_price=100 + (i % 5) * 3,
            low_price=97,
        )
        for i in range(12)
    ]
    a = score_opportunities(rows)
    b = score_opportunities(list(reversed(rows)))
    assert a == b
    assert len(a) == 12
    for i in range(1, len(a)):
        assert a[i - 1].score >= a[i].score


def test_keeps_every_score_and_percentile_inside_0_100_and_stays_non_directional() -> None:
    ranked = score_opportunities(
        [
            row("A", high_price=300, low_price=50),
            row("B", quote_volume24h=5_000_000_000, trades24h=9_000_000),
            row("C"),
        ]
    )
    for o in ranked:
        assert 0 <= o.score <= 100
        for pct in (o.volatility_percentile, o.liquidity_percentile, o.activity_percentile):
            assert 0 <= pct <= 100
        # Discovery copy must never smuggle in a direction call.
        assert not re.search(r"\b(long|short|buy|sell|bullish|bearish)\b", o.reason, re.I)


def test_marks_curated_universe_tokens_as_tracked_and_resolves_their_names() -> None:
    ranked = score_opportunities([row("SOL"), row("NEWCOIN")])
    sol = next(o for o in ranked if o.ticker == "SOL")
    newcoin = next(o for o in ranked if o.ticker == "NEWCOIN")
    assert (sol.tracked, sol.name) == (True, "Solana")
    assert (newcoin.tracked, newcoin.name) == (False, "NEWCOIN")


def test_build_demo_scan_is_deterministic_and_clearly_labeled_demo() -> None:
    a = build_demo_scan()
    b = build_demo_scan()
    assert a.source == "demo"
    assert a.opportunities == b.opportunities
    assert 0 < len(a.opportunities) <= 12
    assert a.spikes == []


def _opp(ticker: str) -> MarketOpportunity:
    return MarketOpportunity(
        ticker=ticker,
        name=ticker,
        price=100,
        change24h=0,
        range_percent24h=0,
        quote_volume24h=0,
        trades24h=0,
        score=0,
        volatility_percentile=0,
        liquidity_percentile=0,
        activity_percentile=0,
        tracked=False,
        reason="",
    )


def _calm() -> list[Candle]:
    return [
        Candle(time=i, open=100, high=100.5, low=99.5, close=100, volume=1_000)
        for i in range(REF_WINDOW)
    ]


def _up_spike_reject(volume: float) -> list[Candle]:
    return [
        *_calm(),
        Candle(time=REF_WINDOW, open=100, high=110, low=100, close=100, volume=volume),
    ]


async def test_scan_spikes_returns_only_spiking_pairs_ranked_by_volume_multiple() -> None:
    klines = {
        "AAA": _calm(),  # no spike
        "BBB": _up_spike_reject(8_000),  # volume_mult 8
        "CCC": _up_spike_reject(12_000),  # 12x
    }

    async def fetch(ticker: str) -> list[Candle]:
        return klines.get(ticker, [])

    hits = await scan_spikes([_opp("AAA"), _opp("BBB"), _opp("CCC")], fetch)
    assert [h.ticker for h in hits] == ["CCC", "BBB"]
    assert hits[0].spike.direction == "up"
    assert hits[0].tracked is False


async def test_scan_spikes_returns_nothing_when_the_tier_is_calm() -> None:
    async def fetch(_ticker: str) -> list[Candle]:
        return _calm()

    hits = await scan_spikes([_opp("AAA"), _opp("BBB")], fetch)
    assert hits == []
