"""Port of external-context.test.ts (ingester plane) — provider normalizers
never emit NaN rows, and the fear/greed bands hold."""

from smc.external_context import (
    fear_greed_label,
    normalize_coingecko_global,
    normalize_coinmarketcap_global,
)

# A trimmed but shape-faithful CoinGecko /global response.
GLOBAL_FIXTURE = {
    "data": {
        "active_cryptocurrencies": 17_468,
        "total_market_cap": {"usd": 3_710_000_000_000, "eur": 3_420_000_000_000},
        "total_volume": {"usd": 130_000_000_000},
        "market_cap_percentage": {"btc": 58.43, "eth": 11.21, "usdt": 4.5},
        "market_cap_change_percentage_24h_usd": -0.91,
        "updated_at": 1_752_400_000,
    }
}


class TestNormalizeCoinGeckoGlobal:
    def test_extracts_mcap_dominance_and_change(self) -> None:
        snap = normalize_coingecko_global(GLOBAL_FIXTURE)
        assert snap is not None
        assert snap.total_mcap_usd == 3_710_000_000_000
        assert snap.btc_dominance == 58.43
        assert snap.eth_dominance == 11.21
        assert snap.mcap_change_24h_pct == -0.91
        assert snap.source == "coingecko"

    def test_tolerates_missing_optional_fields(self) -> None:
        snap = normalize_coingecko_global(
            {"data": {"total_market_cap": {"usd": 1e12}, "market_cap_percentage": {"btc": 60}}}
        )
        assert snap is not None
        assert snap.total_mcap_usd == 1e12
        assert snap.btc_dominance == 60
        assert snap.eth_dominance is None
        assert snap.mcap_change_24h_pct is None

    def test_returns_none_on_schema_drift(self) -> None:
        assert normalize_coingecko_global(None) is None
        assert normalize_coingecko_global({}) is None
        assert normalize_coingecko_global({"data": {}}) is None
        assert normalize_coingecko_global({"data": {"total_market_cap": {"usd": "3.7T"}}}) is None
        assert (
            normalize_coingecko_global(
                {
                    "data": {
                        "total_market_cap": {"usd": 1e12},
                        "market_cap_percentage": {"btc": float("nan")},
                    }
                }
            )
            is None
        )
        # Zero/negative mcap or dominance is provider garbage, not data.
        assert (
            normalize_coingecko_global(
                {"data": {"total_market_cap": {"usd": 0}, "market_cap_percentage": {"btc": 60}}}
            )
            is None
        )


# Trimmed but shape-faithful CoinMarketCap /v1/global-metrics/quotes/latest.
CMC_GLOBAL_FIXTURE = {
    "status": {"error_code": 0, "credit_count": 1},
    "data": {
        "active_cryptocurrencies": 9021,
        "btc_dominance": 58.43,
        "eth_dominance": 11.21,
        "quote": {
            "USD": {
                "total_market_cap": 3_710_000_000_000,
                "total_volume_24h": 130_000_000_000,
                "total_market_cap_yesterday_percentage_change": -0.91,
            }
        },
    },
}


class TestNormalizeCoinMarketCapGlobal:
    def test_extracts_mcap_dominance_and_change(self) -> None:
        snap = normalize_coinmarketcap_global(CMC_GLOBAL_FIXTURE)
        assert snap is not None
        assert snap.total_mcap_usd == 3_710_000_000_000
        assert snap.btc_dominance == 58.43
        assert snap.eth_dominance == 11.21
        assert snap.mcap_change_24h_pct == -0.91
        assert snap.source == "coinmarketcap"

    def test_tolerates_missing_optional_fields(self) -> None:
        snap = normalize_coinmarketcap_global(
            {"data": {"btc_dominance": 60, "quote": {"USD": {"total_market_cap": 1e12}}}}
        )
        assert snap is not None
        assert snap.total_mcap_usd == 1e12
        assert snap.btc_dominance == 60
        assert snap.eth_dominance is None
        assert snap.mcap_change_24h_pct is None

    def test_returns_none_on_schema_drift(self) -> None:
        assert normalize_coinmarketcap_global(None) is None
        assert normalize_coinmarketcap_global({}) is None
        assert normalize_coinmarketcap_global({"data": {"btc_dominance": 60}}) is None
        assert (
            normalize_coinmarketcap_global(
                {"data": {"btc_dominance": 0, "quote": {"USD": {"total_market_cap": 1e12}}}}
            )
            is None
        )


class TestFearGreedLabel:
    def test_maps_the_alternative_me_bands(self) -> None:
        assert fear_greed_label(80) == "Extreme Greed"
        assert fear_greed_label(60) == "Greed"
        assert fear_greed_label(50) == "Neutral"
        assert fear_greed_label(30) == "Fear"
        assert fear_greed_label(10) == "Extreme Fear"
