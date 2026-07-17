"""Port of token-events.test.ts — asset detection rules, the classifier's
first-match-wins kinds, roundup dropping, and the info-headline gate."""

from dataclasses import replace

from smc.news_rss import RssItemRaw, parse_rss_items
from smc.token_events import classify_token_events, detect_event_assets

PUBLISHED_MS = 1_783_900_800_000  # 2026-07-12T00:00:00Z


def item(headline: str, description: str = "", **overrides: object) -> RssItemRaw:
    raw = RssItemRaw(
        headline=headline,
        description=description,
        url="https://example.com/a",
        guid="guid-1",
        published_at_ms=PUBLISHED_MS,
    )
    return replace(raw, **overrides)  # type: ignore[arg-type]


class TestDetectEventAssets:
    def test_matches_by_name_case_insensitively_and_ticker(self) -> None:
        assert "SOL" in detect_event_assets("Solana validators approve change")
        found = detect_event_assets("SOL rallies as ETH lags")
        assert "SOL" in found and "ETH" in found

    def test_short_tickers_require_exact_uppercase(self) -> None:
        assert "OP" not in detect_event_assets("a great photo op for the president")
        assert "AR" not in detect_event_assets("the suspect fled to another ar ea")
        assert "OP" in detect_event_assets("OP mainnet fees drop after upgrade")
        # Longer tickers stay case-insensitive.
        assert "AVAX" in detect_event_assets("avax subnet growth")

    def test_matches_worker_universe_extension_tokens(self) -> None:
        assert "TIA" in detect_event_assets("Celestia unlock schedule published")
        assert "ARB" in detect_event_assets("Arbitrum DAO vote passes")

    def test_directory_tickers_uppercase_exact_only(self) -> None:
        directory = ["DEXE", "SXT", "SAND", "T"]
        assert "DEXE" in detect_event_assets("DEXE announces vesting cliff", directory)
        # Lowercase/prose forms of directory tickers never match.
        assert detect_event_assets("children play in the sand by the beach", directory) == []
        assert detect_event_assets("dexe protocol update", directory) == []
        # 1-char bases are never matched — a bare capital letter is noise.
        assert detect_event_assets("Model T production halted", directory) == []

    def test_stoplists_acronym_bases(self) -> None:
        directory = ["AI", "NFT", "ID", "DEXE"]
        assert detect_event_assets("AI tokens rally as NFT volumes slide", directory) == []

    def test_universe_priority_and_cap_of_four(self) -> None:
        directory = ["DEXE", "SXT", "OPN", "UTK"]
        found = detect_event_assets("SOL ETH ARB TIA DEXE SXT all unlock simultaneously", directory)
        assert len(found) == 4
        assert {"SOL", "ETH", "ARB", "TIA"} <= set(found)

    def test_no_double_report_of_universe_tickers_in_directory(self) -> None:
        assert detect_event_assets("SOL validators pause network", ["SOL"]) == ["SOL"]


class TestClassifyTokenEvents:
    def test_exploit_is_critical_security_winning_over_other_kinds(self) -> None:
        events = classify_token_events(
            [item("Curve pools drained in $5M exploit ahead of exchange listing on Binance")],
            "cointelegraph",
        )
        crv = next((e for e in events if e.symbol == "CRV"), None)
        assert crv is not None
        assert crv.kind == "security"
        assert crv.severity == "critical"

    def test_unlocks_and_regulatory_are_warnings(self) -> None:
        events = classify_token_events(
            [
                item("Arbitrum to unlock $120M of ARB next week", guid="g-unlock"),
                item("SEC sues over Solana sales", guid="g-reg"),
            ],
            "coindesk",
        )
        arb = next(e for e in events if e.symbol == "ARB")
        assert arb.kind == "unlock"
        assert arb.severity == "warning"
        assert next(e for e in events if e.symbol == "SOL").kind == "regulatory"

    def test_nothing_without_token_or_kind_match(self) -> None:
        assert classify_token_events([item("Massive exchange hack drains $100M")], "x") == []
        assert classify_token_events([item("Bitcoin price steady this weekend")], "x") == []

    def test_dedup_keys_stable_per_source_article_symbol_kind(self) -> None:
        a = classify_token_events([item("ETH unlock looms")], "src")[0]
        b = classify_token_events([item("ETH unlock looms")], "src")[0]
        assert a.dedup_key == b.dedup_key
        other = classify_token_events([item("ETH unlock looms")], "other-src")[0]
        assert other.dedup_key != a.dedup_key

    def test_out_of_universe_tokens_via_directory(self) -> None:
        events = classify_token_events(
            [item("DEXE team wallet unlock scheduled for next month")],
            "cointelegraph",
            extra_tickers=["DEXE", "SXT"],
        )
        assert len(events) == 1
        assert events[0].symbol == "DEXE"
        assert events[0].kind == "unlock"
        assert events[0].severity == "warning"

    def test_drops_roundup_headlines_whole(self) -> None:
        roundups = [
            "SOL, ADA, XRP price analysis: unlock season regulatory pressure builds",
            "Top 5 cryptos to watch this week: BTC ETH SOL upgrade lawsuits and more",
            "Weekly market wrap: DOGE PEPE WIF hack fears and vesting cliffs",
        ]
        for headline in roundups:
            assert classify_token_events([item(headline)], "cointelegraph") == []

    def test_keeps_genuine_multi_asset_story(self) -> None:
        events = classify_token_events(
            [item("Bridge exploit drains funds from SOL, AVAX and NEAR ecosystems")],
            "cointelegraph",
        )
        assert len(events) >= 3
        assert all(e.kind == "security" for e in events)

    def test_info_kinds_require_headline_mention(self) -> None:
        # Listing kind (info): UNI only in the description → dropped.
        buried = classify_token_events(
            [item("Exchange announces new listings for Q3", "Uniswap listed on Upbit next week")],
            "cointelegraph",
        )
        assert buried == []
        # Same story with the token in the headline → kept.
        headline = classify_token_events(
            [item("Uniswap listed on Upbit next week")], "cointelegraph"
        )
        assert len(headline) == 1
        assert headline[0].symbol == "UNI"
        assert headline[0].kind == "listing"
        # Warning/critical kinds keep the wider net: description-only records.
        critical = classify_token_events(
            [item("Major DeFi protocol suffers incident", "Aave contracts exploited overnight")],
            "cointelegraph",
        )
        assert any(e.symbol == "AAVE" and e.kind == "security" for e in critical)

    def test_classifies_straight_from_parsed_rss_xml(self) -> None:
        xml = """<rss><channel>
          <item><title>Aave contract vulnerability patched after whitehat report</title>
            <link>https://example.com/aave</link><guid>aave-1</guid>
            <pubDate>Sat, 12 Jul 2026 08:00:00 GMT</pubDate>
            <description><![CDATA[Funds safe, says team.]]></description></item>
          <item><title>Weather is nice today</title><guid>x</guid></item>
        </channel></rss>"""
        events = classify_token_events(parse_rss_items(xml), "cointelegraph")
        assert len(events) == 1
        assert events[0].symbol == "AAVE"
        assert events[0].kind == "security"
        assert events[0].published_at == "2026-07-12T08:00:00.000Z"
