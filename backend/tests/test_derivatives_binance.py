"""The derivatives fetch plane, against a mocked transport.

No live Binance call anywhere: `httpx.MockTransport` answers every route, so
these tests pin the parsing and the failure convention (a bad feed yields
None, never a zero) rather than whatever the exchange printed today.
"""

from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from app.derivatives import binance as client

SLOT = datetime(2026, 8, 2, 12, 0, tzinfo=UTC)

OPEN_INTEREST = {"symbol": "BTCUSDT", "openInterest": "84000.5", "time": 1754136000000}
OI_HIST = [
    {
        "symbol": "BTCUSDT",
        "sumOpenInterest": "84000.5",
        "sumOpenInterestValue": "8400050000.0",
        "timestamp": 1754136000000,
    }
]
PREMIUM = {
    "symbol": "BTCUSDT",
    "markPrice": "100050.00",
    "indexPrice": "100000.00",
    "lastFundingRate": "0.00012",
    "nextFundingTime": 1754150400000,
    "time": 1754136000000,
}
RATIO = [{"symbol": "BTCUSDT", "longShortRatio": "1.85", "timestamp": 1754136000000}]
# open, high, low, close, volume, ..., field 9 = taker buy base volume
CLOSED_BAR = [1754135700000, "1", "1", "1", "100.0", "1000.0", 0, "0", 0, "740.0", "0", "0"]
OPEN_BAR = [1754136000000, "1", "1", "1", "101.0", "10.0", 0, "0", 0, "1.0", "0", "0"]


def make_client(routes: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Install a mock transport and return the list of paths that get hit."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        body = routes.get(request.url.path, "missing")
        if body == "missing":
            return httpx.Response(404, json={"code": -1121, "msg": "Invalid symbol."})
        if isinstance(body, int):
            return httpx.Response(body, text="upstream error")
        return httpx.Response(200, json=body)

    mock = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(client, "http_client", lambda: mock)

    async def no_wait(_weight: float) -> None:
        return None

    monkeypatch.setattr(client, "acquire_weight", no_wait)
    return seen


HAPPY_ROUTES: dict[str, Any] = {
    "/fapi/v1/openInterest": OPEN_INTEREST,
    "/futures/data/openInterestHist": OI_HIST,
    "/fapi/v1/premiumIndex": PREMIUM,
    "/futures/data/globalLongShortAccountRatio": RATIO,
    "/futures/data/topLongShortAccountRatio": RATIO,
    "/futures/data/topLongShortPositionRatio": RATIO,
    "/fapi/v1/klines": [CLOSED_BAR, OPEN_BAR],
}


# --- symbol keys ---------------------------------------------------------


def test_canonical_symbol() -> None:
    assert client.canonical_symbol("btc") == "BTCUSDT"
    assert client.canonical_symbol("BTCUSDT") == "BTCUSDT"
    assert client.canonical_symbol("pepe") == "PEPEUSDT"
    assert client.canonical_symbol("btc-usdt") == "BTCUSDT"


# --- individual endpoints ------------------------------------------------


async def test_fetch_open_interest(monkeypatch: pytest.MonkeyPatch) -> None:
    make_client(HAPPY_ROUTES, monkeypatch)
    assert await client.fetch_open_interest("BTCUSDT") == pytest.approx(84000.5)


async def test_fetch_open_interest_hist_parses_both_legs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_client(HAPPY_ROUTES, monkeypatch)
    rows = await client.fetch_open_interest_hist("BTCUSDT")
    assert rows[0]["open_interest"] == pytest.approx(84000.5)
    assert rows[0]["open_interest_usd"] == pytest.approx(8_400_050_000.0)


async def test_fetch_open_interest_hist_skips_rows_without_a_timestamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_client(
        {"/futures/data/openInterestHist": [{"sumOpenInterest": "1"}, *OI_HIST]}, monkeypatch
    )
    assert len(await client.fetch_open_interest_hist("BTCUSDT")) == 1


async def test_fetch_premium_index_derives_basis_and_premium(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_client(HAPPY_ROUTES, monkeypatch)
    read = await client.fetch_premium_index("BTCUSDT")
    assert read["basis"] == pytest.approx(50.0)
    assert read["premium"] == pytest.approx(0.0005)
    assert read["funding_rate"] == pytest.approx(0.00012)


async def test_fetch_premium_index_with_a_zero_index_price(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Division by an index of zero must yield None, not an exception."""
    make_client({"/fapi/v1/premiumIndex": {**PREMIUM, "indexPrice": "0"}}, monkeypatch)
    read = await client.fetch_premium_index("BTCUSDT")
    assert read["premium"] is None


async def test_fetch_ratios(monkeypatch: pytest.MonkeyPatch) -> None:
    make_client(HAPPY_ROUTES, monkeypatch)
    assert await client.fetch_long_short_ratio("BTCUSDT") == pytest.approx(1.85)
    assert await client.fetch_top_trader_accounts_ratio("BTCUSDT") == pytest.approx(1.85)
    assert await client.fetch_top_trader_positions_ratio("BTCUSDT") == pytest.approx(1.85)


async def test_fetch_taker_flow_uses_the_closed_bar(monkeypatch: pytest.MonkeyPatch) -> None:
    """The still-forming bar's buy/sell split flips around until it closes."""
    make_client(HAPPY_ROUTES, monkeypatch)
    buy, sell, close = await client.fetch_taker_flow("BTCUSDT")
    assert buy == pytest.approx(740.0)
    assert sell == pytest.approx(260.0)
    assert close == pytest.approx(100.0)


async def test_fetch_taker_flow_on_a_short_row(monkeypatch: pytest.MonkeyPatch) -> None:
    make_client({"/fapi/v1/klines": [[1, "1", "1", "1", "1", "1"]]}, monkeypatch)
    assert await client.fetch_taker_flow("BTCUSDT") == (None, None, None)


async def test_fetch_funding_rate_history(monkeypatch: pytest.MonkeyPatch) -> None:
    make_client({"/fapi/v1/fundingRate": [{"fundingRate": "-0.0003"}]}, monkeypatch)
    assert await client.fetch_funding_rate("BTCUSDT") == pytest.approx(-0.0003)


# --- failure convention --------------------------------------------------


async def test_every_fetcher_degrades_to_none_on_a_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_client({}, monkeypatch)
    assert await client.fetch_open_interest("NOPEUSDT") is None
    assert await client.fetch_open_interest_hist("NOPEUSDT") == []
    assert await client.fetch_premium_index("NOPEUSDT") == {}
    assert await client.fetch_long_short_ratio("NOPEUSDT") is None
    assert await client.fetch_funding_rate("NOPEUSDT") is None
    assert await client.fetch_taker_flow("NOPEUSDT") == (None, None, None)


async def test_a_transport_error_degrades_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down")

    mock = httpx.AsyncClient(transport=httpx.MockTransport(boom))
    monkeypatch.setattr(client, "http_client", lambda: mock)
    assert await client.fetch_open_interest("BTCUSDT") is None


async def test_a_non_json_body_degrades_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    make_client({"/fapi/v1/openInterest": 500}, monkeypatch)
    assert await client.fetch_open_interest("BTCUSDT") is None


async def test_a_200_carrying_html_degrades_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Binance's edge occasionally answers 200 with an error page."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>maintenance</html>")

    mock = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(client, "http_client", lambda: mock)
    assert await client.fetch_open_interest("BTCUSDT") is None


async def test_open_interest_hist_skips_non_dict_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_client({"/futures/data/openInterestHist": ["garbage", *OI_HIST]}, monkeypatch)
    assert len(await client.fetch_open_interest_hist("BTCUSDT")) == 1


async def test_taker_flow_without_a_volume_still_reports_the_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bar with an unparseable volume must not invent a 50/50 split."""
    broken = [1754135700000, "1", "1", "1", "100.0", None, 0, "0", 0, None, "0", "0"]
    make_client({"/fapi/v1/klines": [broken, OPEN_BAR]}, monkeypatch)
    buy, sell, close = await client.fetch_taker_flow("BTCUSDT")
    assert (buy, sell) == (None, None)
    assert close == pytest.approx(100.0)


# --- the assembled snapshot ---------------------------------------------


async def test_fetch_snapshot_assembles_every_field(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = make_client(HAPPY_ROUTES, monkeypatch)
    snapshot = await client.fetch_snapshot("BTC", timestamp=SLOT, market_cap=2_000_000_000_000.0)

    assert snapshot.symbol == "BTCUSDT"
    assert snapshot.timestamp == SLOT
    assert snapshot.open_interest == pytest.approx(84000.5)
    assert snapshot.open_interest_usd == pytest.approx(8_400_050_000.0)
    assert snapshot.funding_rate == pytest.approx(0.00012)
    assert snapshot.long_short_ratio == pytest.approx(1.85)
    assert snapshot.top_trader_accounts_ratio == pytest.approx(1.85)
    assert snapshot.top_trader_positions_ratio == pytest.approx(1.85)
    assert snapshot.taker_buy_volume == pytest.approx(740.0)
    assert snapshot.taker_sell_volume == pytest.approx(260.0)
    assert snapshot.basis == pytest.approx(50.0)
    assert snapshot.premium == pytest.approx(0.0005)
    assert snapshot.price == pytest.approx(100050.0)
    assert snapshot.oi_marketcap_ratio == pytest.approx(8_400_050_000.0 / 2_000_000_000_000.0)

    # The funding-rate history endpoint is the fallback only — premiumIndex
    # already carried the rate, so the happy path costs no extra request.
    assert "/fapi/v1/fundingRate" not in seen


async def test_fetch_snapshot_falls_back_to_the_funding_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    routes = dict(HAPPY_ROUTES)
    routes["/fapi/v1/premiumIndex"] = {**PREMIUM, "lastFundingRate": None}
    routes["/fapi/v1/fundingRate"] = [{"fundingRate": "0.00033"}]
    seen = make_client(routes, monkeypatch)

    snapshot = await client.fetch_snapshot("BTC", timestamp=SLOT)
    assert snapshot.funding_rate == pytest.approx(0.00033)
    assert "/fapi/v1/fundingRate" in seen


async def test_fetch_snapshot_unwinds_the_1000x_contract_scale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """PEPE trades as 1000PEPEUSDT. The stored row must be real PEPE — real
    price, real token count — or it joins onto nothing else in Market Pulse."""
    seen = make_client(HAPPY_ROUTES, monkeypatch)
    snapshot = await client.fetch_snapshot("PEPE", timestamp=SLOT)

    assert snapshot.symbol == "PEPEUSDT"
    assert snapshot.price == pytest.approx(100050.0 / 1000)
    assert snapshot.open_interest == pytest.approx(84000.5 * 1000)
    assert snapshot.basis == pytest.approx(50.0 / 1000)
    # Notional and premium are scale-free.
    assert snapshot.open_interest_usd == pytest.approx(8_400_050_000.0)
    assert snapshot.premium == pytest.approx(0.0005)
    assert seen  # the 1000x pair is what actually got requested
    assert all("1000PEPE" in path or path.startswith("/f") for path in seen)


async def test_fetch_snapshot_without_a_market_cap_leaves_the_ratio_null(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_client(HAPPY_ROUTES, monkeypatch)
    snapshot = await client.fetch_snapshot("BTC", timestamp=SLOT, market_cap=None)
    assert snapshot.oi_marketcap_ratio is None


async def test_fetch_snapshot_survives_a_total_outage(monkeypatch: pytest.MonkeyPatch) -> None:
    make_client({}, monkeypatch)
    snapshot = await client.fetch_snapshot("BTC", timestamp=SLOT)
    assert snapshot.symbol == "BTCUSDT"
    assert snapshot.open_interest is None
    assert snapshot.price is None
    assert snapshot.funding_rate is None


# --- market caps ---------------------------------------------------------


async def test_market_caps_are_keyed_by_ticker(monkeypatch: pytest.MonkeyPatch) -> None:
    client.reset_marketcap_cache()

    def handler(request: httpx.Request) -> httpx.Response:
        assert "bitcoin" in request.url.params["ids"]
        return httpx.Response(
            200,
            json={
                "bitcoin": {"usd": 100000, "usd_market_cap": 2_000_000_000_000},
                "ethereum": {"usd": 4000, "usd_market_cap": 480_000_000_000},
            },
        )

    mock = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(client, "http_client", lambda: mock)

    caps = await client.fetch_market_caps(["BTC", "ETH"], now=0.0)
    assert caps["BTC"] == pytest.approx(2_000_000_000_000)
    assert caps["ETH"] == pytest.approx(480_000_000_000)
    client.reset_marketcap_cache()


async def test_market_caps_are_cached_for_an_hour(monkeypatch: pytest.MonkeyPatch) -> None:
    client.reset_marketcap_cache()
    calls: list[int] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"bitcoin": {"usd_market_cap": 2_000_000_000_000}})

    mock = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(client, "http_client", lambda: mock)

    await client.fetch_market_caps(["BTC"], now=0.0)
    await client.fetch_market_caps(["BTC"], now=60.0)
    assert len(calls) == 1
    await client.fetch_market_caps(["BTC"], now=4000.0)
    assert len(calls) == 2
    client.reset_marketcap_cache()


async def test_market_caps_are_empty_without_a_mapped_ticker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ticker with no `ASSET_IDS` entry produces no key — never a guess."""
    client.reset_marketcap_cache()
    monkeypatch.setattr(client, "http_client", lambda: None)
    assert await client.fetch_market_caps(["NOSUCHCOIN"], now=0.0) == {}


async def test_a_coingecko_outage_returns_the_last_good_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client.reset_marketcap_cache()
    state = {"fail": False}

    def handler(_request: httpx.Request) -> httpx.Response:
        if state["fail"]:
            return httpx.Response(429, text="rate limited")
        return httpx.Response(200, json={"bitcoin": {"usd_market_cap": 2_000_000_000_000}})

    mock = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(client, "http_client", lambda: mock)

    await client.fetch_market_caps(["BTC"], now=0.0)
    state["fail"] = True
    stale = await client.fetch_market_caps(["BTC"], now=4000.0)
    assert stale["BTC"] == pytest.approx(2_000_000_000_000)
    client.reset_marketcap_cache()


async def test_a_market_cap_transport_error_returns_the_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client.reset_marketcap_cache()

    def boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down")

    mock = httpx.AsyncClient(transport=httpx.MockTransport(boom))
    monkeypatch.setattr(client, "http_client", lambda: mock)
    assert await client.fetch_market_caps(["BTC"], now=0.0) == {}


async def test_a_market_cap_payload_of_the_wrong_shape_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client.reset_marketcap_cache()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=["not", "a", "dict"])

    mock = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(client, "http_client", lambda: mock)
    assert await client.fetch_market_caps(["BTC"], now=0.0) == {}


async def test_a_zero_or_missing_market_cap_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CoinGecko returns 0 for coins it has no cap for. Zero is not a cap."""
    client.reset_marketcap_cache()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "bitcoin": {"usd_market_cap": 0},
                "ethereum": {"usd": 4000},
                "unmapped-coin": {"usd_market_cap": 5},
            },
        )

    mock = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(client, "http_client", lambda: mock)
    assert await client.fetch_market_caps(["BTC", "ETH"], now=0.0) == {}
    client.reset_marketcap_cache()
