"""Announcement parsing — every title in here is a real one, copied verbatim
from Binance's catalog 48 feed on 2026-08-15.

The parser's expensive failure is a *false* listing (a ticker that Binance
never listed appearing on a buy screener), so most of these cases assert on
what it refuses.
"""

from datetime import UTC, datetime

from smc.listing_calendar import (
    classify_venue,
    extract_listing_date,
    extract_listing_time,
    extract_symbols,
    flatten_article_body,
    is_noise,
    parse_announcement,
    parse_announcements,
)


def article(title: str, code: str = "abc123", released_ms: int = 1786605305015) -> dict:
    return {"id": 1, "code": code, "title": title, "type": 1, "releaseDate": released_ms}


class TestNoiseRejection:
    def test_tradfi_perpetuals_are_not_crypto_listings(self) -> None:
        title = "Binance Futures Will Launch Multiple USDⓈ-Margined TradFi Perpetual Contracts (2026-08-14)"
        assert is_noise(title) == "tradfi_perpetual"

    def test_tokenized_equities_are_rejected(self) -> None:
        assert is_noise("Binance Exchange Adds 1 bStocks Trading Pair on Binance Spot") == (
            "tokenized_equity"
        )
        assert is_noise("Binance Will Add SKHYB Tokenized Securities as Collateral Assets") == (
            "tokenized_equity"
        )

    def test_operational_notices_are_rejected(self) -> None:
        assert is_noise("Binance Margin Will Add New Pairs - 2026-06-30") == "margin_pairs"
        assert is_noise("Binance Futures Will List USDⓈ-M & COIN-M Quarterly 1225 Delivery Contracts") == (
            "delivery_contract"
        )

    def test_a_real_listing_is_not_noise(self) -> None:
        assert is_noise("Binance Will List Aerodrome (AERO) with Seed Tag Applied") is None

    def test_rejected_article_keeps_its_reason_and_yields_no_symbols(self) -> None:
        parsed = parse_announcement(
            article("Binance Exchange Adds 10 bStocks Trading Pairs on Binance Spot - 2026-08-05")
        )
        assert parsed is not None
        assert parsed.rejected_because == "tokenized_equity"
        assert parsed.symbols == []
        assert parsed.is_listing is False


class TestVenue:
    def test_futures_titles(self) -> None:
        assert classify_venue(
            "Binance Futures Will Launch USDⓈ-Margined DOSUSDT Perpetual Contract (2026-08-11)"
        ) == "FUTURES"

    def test_spot_listing(self) -> None:
        assert classify_venue("Binance Will List Aerodrome (AERO) with Seed Tag Applied") == "SPOT"

    def test_hodler_airdrop(self) -> None:
        assert classify_venue(
            "Introducing OpenGradient (OPG) on Binance HODLer Airdrops! Earn OPG With Retroactive BNB"
        ) == "HODLER_AIRDROP"

    def test_unknown_title_is_other(self) -> None:
        assert classify_venue("Binance Adds USDT/AED Spot Trading Pair") == "SPOT"
        assert classify_venue("Notice on Something Entirely Unrelated") == "OTHER"


class TestSymbolExtraction:
    def test_futures_contract_symbol(self) -> None:
        title = "Binance Futures Will Launch USDⓈ-Margined DOSUSDT Perpetual Contract (2026-08-11)"
        assert extract_symbols(title, "FUTURES") == ["DOS"]

    def test_multiple_futures_contracts(self) -> None:
        title = (
            "Binance Futures Will Launch USDⓈ-Margined DATAIPUSDT and DATAIPUSDC "
            "Perpetual Contracts (2026-07-03)"
        )
        assert extract_symbols(title, "FUTURES") == ["DATAIP"]

    def test_bulk_article_names_no_ticker(self) -> None:
        title = "Binance Futures Will Launch Multiple USDⓈ-Margined Perpetual Contracts (2026-08-14)"
        assert extract_symbols(title, "FUTURES") == []

    def test_spot_listing_reads_the_parenthesised_ticker(self) -> None:
        title = "Binance Will List Aerodrome (AERO) with Seed Tag Applied"
        assert extract_symbols(title, "SPOT") == ["AERO"]

    def test_two_assets_in_one_spot_article(self) -> None:
        title = "Binance Will List Genius Terminal (GENIUS) and OpenGradient (OPG) with Seed Tag Applied"
        assert extract_symbols(title, "SPOT") == ["GENIUS", "OPG"]

    def test_a_trailing_date_is_never_read_as_a_ticker(self) -> None:
        title = "Binance Will List Something (2026-08-14)"
        assert extract_symbols(title, "SPOT") == []

    def test_stopwords_are_not_tickers(self) -> None:
        title = "Binance Will Add Foo (UTC) and Bar (VIP)"
        assert extract_symbols(title, "SPOT") == []


class TestDates:
    def test_parenthesised_date(self) -> None:
        title = "Binance Futures Will Launch USDⓈ-Margined DOSUSDT Perpetual Contract (2026-08-11)"
        parsed = extract_listing_date(title)
        assert parsed is not None
        assert parsed.isoformat() == "2026-08-11"

    def test_trailing_dash_date(self) -> None:
        parsed = extract_listing_date("Binance Exchange Adds 1 Trading Pair on Spot - 2026-08-12")
        assert parsed is not None
        assert parsed.isoformat() == "2026-08-12"

    def test_last_date_wins_when_two_are_present(self) -> None:
        parsed = extract_listing_date("Notice on New Trading Pairs 2026-07-28 - 2026-07-30")
        assert parsed is not None
        assert parsed.isoformat() == "2026-07-30"

    def test_no_date(self) -> None:
        assert extract_listing_date("Binance Will List Aerodrome (AERO)") is None


class TestBodyListingTime:
    def test_exact_utc_time(self) -> None:
        body = (
            "Binance Futures will launch the following perpetual contract(s) as below: "
            "2026-08-11 15:00 (UTC): DOSUSDT Perpetual Contract with up to 20x leverage"
        )
        assert extract_listing_time(body) == datetime(2026, 8, 11, 15, 0, tzinfo=UTC)

    def test_first_occurrence_wins(self) -> None:
        body = "Launch 2026-08-11 15:00 (UTC) ... Funding settles 2026-08-11 19:00 (UTC)"
        assert extract_listing_time(body) == datetime(2026, 8, 11, 15, 0, tzinfo=UTC)

    def test_no_timestamp(self) -> None:
        assert extract_listing_time("No time in this body at all.") is None

    def test_flatten_walks_the_node_tree(self) -> None:
        tree = {
            "node": "root",
            "child": [
                {
                    "node": "element",
                    "tag": "p",
                    "child": [
                        {"node": "text", "text": "Launch Time"},
                        {"node": "text", "text": "2026-08-11 15:00 (UTC)"},
                    ],
                }
            ],
        }
        flattened = flatten_article_body(tree)
        assert "Launch Time" in flattened
        assert extract_listing_time(flattened) == datetime(2026, 8, 11, 15, 0, tzinfo=UTC)


class TestParseAnnouncement:
    def test_full_parse_of_a_real_futures_listing(self) -> None:
        parsed = parse_announcement(
            article(
                "Binance Futures Will Launch USDⓈ-Margined DOSUSDT Perpetual Contract (2026-08-11)",
                code="a2ee872d",
            )
        )
        assert parsed is not None
        assert parsed.venue == "FUTURES"
        assert parsed.symbols == ["DOS"]
        assert parsed.is_listing
        assert parsed.url.endswith("a2ee872d")
        assert parsed.listing_date is not None

    def test_seed_tag_is_detected(self) -> None:
        parsed = parse_announcement(
            article("Binance Will List Aerodrome (AERO) with Seed Tag Applied")
        )
        assert parsed is not None
        assert parsed.seed_tag is True

    def test_structurally_broken_rows_are_dropped(self) -> None:
        assert parse_announcement({"title": "", "code": "x", "releaseDate": 1}) is None
        assert parse_announcement({"title": "Listing", "code": "x"}) is None

    def test_parse_announcements_skips_only_unusable_rows(self) -> None:
        rows = [
            article("Binance Will List Aerodrome (AERO) with Seed Tag Applied"),
            article("Binance Exchange Adds 1 bStocks Trading Pair on Binance Spot"),
            {"title": "", "code": "", "releaseDate": None},
        ]
        parsed = parse_announcements(rows)
        assert len(parsed) == 2
        assert [a.is_listing for a in parsed] == [True, False]
