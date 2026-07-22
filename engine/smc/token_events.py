"""Token event intelligence — classifies news items into typed, per-token
events a holder needs to know about: unlocks, security incidents, regulatory
actions, exchange listings/delistings, protocol upgrades. Framework-free and
pure; the worker ingests, Postgres stores, the event watcher notifies.
Matching runs over the full WORKER_UNIVERSE by name or ticker, plus — via
``extra_tickers`` — the whole Binance tradable directory ticker-only, so
discovery-layer tokens get event coverage too. Relevance filtering happens at
notification time, never here. Port of token-events.ts.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from smc.market import WORKER_UNIVERSE
from smc.news_rss import RssItemRaw

TokenEventKind = Literal[
    "unlock", "security", "regulatory", "delisting", "listing", "upgrade", "macro"
]
TokenEventSeverity = Literal["info", "warning", "critical"]

# Reserved pseudo-symbol for market-wide (non-token) events — same convention
# catalyst_event uses for the market backdrop. Macro headlines file here.
MARKET_SYMBOL = "MARKET"


@dataclass(slots=True)
class TokenEventInput:
    symbol: str
    kind: TokenEventKind
    severity: TokenEventSeverity
    title: str
    body: str | None
    source: str
    url: str | None
    # ISO timestamp the article was published.
    published_at: str
    # One row per (article, symbol, kind) — re-ingestion is a no-op.
    dedup_key: str


# Kind patterns, checked in order — the FIRST match wins, so the most
# safety-critical kinds come first (an article about an exploit that also
# mentions a listing is a security event). Severity is per kind.
_KIND_RULES: list[tuple[TokenEventKind, TokenEventSeverity, re.Pattern[str]]] = [
    (
        "security",
        "critical",
        re.compile(
            r"\b(hack(?:ed|er)?s?|exploit(?:ed|s)?|breach(?:ed)?|drain(?:ed|s)?|stolen"
            r"|steal(?:s|ing)?|vulnerabilit\w*|rug[- ]?pull|phishing|attack(?:ed|er)?s?"
            r"|compromised)\b",
            re.IGNORECASE,
        ),
    ),
    ("unlock", "warning", re.compile(r"\b(unlock(?:s|ed|ing)?|vesting|cliff)\b", re.IGNORECASE)),
    ("delisting", "warning", re.compile(r"\b(delist(?:s|ed|ing)?)\b", re.IGNORECASE)),
    (
        "regulatory",
        "warning",
        re.compile(
            r"\b(lawsuit|sues?d?|charges?|indicted?|subpoena\w*|crackdown|fined?|settlement"
            r"|regulat\w*|banned|bans)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "listing",
        "info",
        re.compile(
            r"\b(list(?:s|ed|ing))\b[\s\S]{0,80}\b(binance|coinbase|kraken|upbit|okx|bybit"
            r"|bitget)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "upgrade",
        "info",
        re.compile(
            r"\b(mainnet|hard[- ]?fork|upgrade[sd]?|airdrops?|halving|testnet launch)\b",
            re.IGNORECASE,
        ),
    ),
]


def _escape_re(s: str) -> str:
    return re.escape(s)


@dataclass(slots=True)
class _AssetMatcher:
    ticker: str
    # Case-SENSITIVE for short tickers (≤3 chars) to avoid "photo op" → OP etc.
    ticker_re: re.Pattern[str]
    name_re: re.Pattern[str]


_MATCHERS: list[_AssetMatcher] = [
    _AssetMatcher(
        ticker=entry.ticker,
        # Short tickers are common English words/abbreviations in lowercase
        # prose ("op", "ar", "ena"...) — require the exact uppercase form.
        ticker_re=re.compile(
            rf"\b{_escape_re(entry.ticker)}\b",
            0 if len(entry.ticker) <= 3 else re.IGNORECASE,
        ),
        name_re=re.compile(rf"\b{_escape_re(entry.name)}\b", re.IGNORECASE),
    )
    for entry in WORKER_UNIVERSE
]

_UNIVERSE_TICKERS = {entry.ticker for entry in WORKER_UNIVERSE}

# Real Binance bases that are also everyday crypto-news vocabulary in
# uppercase — matching them ticker-only would tag nearly every article.
_EXTRA_TICKER_STOPLIST = {"AI", "NFT", "ID", "DAO", "MEME", "ACT", "NOT", "WHY"}

# The directory has ~600 bases and the pass runs every few minutes — compile
# each ticker's pattern once, not once per article.
_extra_ticker_re_cache: dict[str, re.Pattern[str]] = {}


def _extra_ticker_re(ticker: str) -> re.Pattern[str]:
    cached = _extra_ticker_re_cache.get(ticker)
    if cached is None:
        cached = re.compile(rf"\b{_escape_re(ticker)}\b")
        _extra_ticker_re_cache[ticker] = cached
    return cached


def _is_matchable_extra(ticker: str) -> bool:
    """Directory tickers (out-of-universe) match on the EXACT uppercase ticker
    only: we have no display names for them, and case-insensitive matching
    over 600 bases would false-positive on common words. 1-char bases are
    skipped — a bare capital letter is noise, not a mention."""
    return (
        len(ticker) >= 2
        and ticker not in _UNIVERSE_TICKERS
        and ticker not in _EXTRA_TICKER_STOPLIST
    )


def detect_event_assets(text: str, extra_tickers: list[str] | None = None) -> list[str]:
    """Tickers whose token this text is about (≤4 to cap broad roundups).
    Universe tokens match by name or ticker; ``extra_tickers`` match
    ticker-only, uppercase-exact."""
    found: list[str] = []
    for m in _MATCHERS:
        if m.ticker_re.search(text) or m.name_re.search(text):
            found.append(m.ticker)
        if len(found) >= 4:
            return found
    for raw in extra_tickers or []:
        ticker = raw.upper()
        if not _is_matchable_extra(ticker):
            continue
        if _extra_ticker_re(ticker).search(text):
            found.append(ticker)
        if len(found) >= 4:
            break
    return found


# Roundup/listicle headlines ("Top 5 cryptos to watch", "Weekly market wrap",
# "SOL, ADA, XRP price analysis...") mention many tokens without being ABOUT
# any of them. A multi-asset item with a headline in this shape drops whole.
_ROUNDUP_HEADLINE_RE = re.compile(
    r"price (analysis|prediction)|top \d|weekly|daily|roundup|market wrap|to watch"
    r"|best cryptos?",
    re.IGNORECASE,
)
_ROUNDUP_MIN_ASSETS = 3

# Market-wide macro headlines (central banks, rate decisions, inflation, jobs,
# tariffs, yields) carry a "macro" tag even when no token ticker is mentioned —
# the user trades tokenized TradFi and reacts to the same macro tape as
# equities. This is an ADDITIVE ingestion tag filed under the reserved MARKET
# pseudo-symbol; it never suppresses the per-token classification below and
# carries no decision semantics. Word-boundaried so "scalper" ≠ "CPI" etc.
_MACRO_RE = re.compile(
    r"\b(fed|fomc|federal reserve|jerome powell|powell"
    r"|rate (?:decision|hike|cut|hold)s?|interest rate?s?|rate cuts?|rate hikes?"
    r"|cpi|ppi|pce|inflation|deflation|disinflation"
    r"|jobs report|nonfarm|non[- ]farm|payrolls?|unemployment|jobless claims"
    r"|gdp|recession|soft landing"
    r"|tariffs?|trade war"
    r"|ecb|european central bank|boj|bank of (?:england|japan)|boe"
    r"|treasury yields?|bond yields?|10[- ]year yield"
    r"|quantitative (?:easing|tightening)|qe|qt)\b",
    re.IGNORECASE,
)


def _hash(s: str) -> str:
    """FNV-1a, for stable dedup keys when a feed item has no guid/url."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:x}"


def classify_token_events(
    items: list[RssItemRaw],
    source: str,
    now_ms: float | None = None,
    extra_tickers: list[str] | None = None,
) -> list[TokenEventInput]:
    """Classify one feed's raw items into token events. An item produces at
    most one kind (first matching rule) across up to 4 matched assets; items
    with no asset match or no kind match produce nothing — event alerts must
    be token-specific, so there is deliberately no "Crypto"-wide fallback."""
    if now_ms is None:
        now_ms = time.time() * 1000
    events: list[TokenEventInput] = []
    for item in items:
        text = f"{item.headline} {item.description}"
        article_key = item.guid or item.url or _hash(item.headline)
        published_ms = item.published_at_ms if item.published_at_ms is not None else now_ms
        published_at = (
            datetime.fromtimestamp(published_ms / 1000, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

        # Additive macro tag: a market-wide economic headline files ONE event
        # under the reserved MARKET symbol even when no token ticker matches.
        # Runs before (and independently of) the per-token classification so it
        # never changes existing token-specific output.
        if _MACRO_RE.search(text):
            events.append(
                TokenEventInput(
                    symbol=MARKET_SYMBOL,
                    kind="macro",
                    severity="info",
                    title=item.headline,
                    body=item.description or None,
                    source=source,
                    url=item.url,
                    published_at=published_at,
                    dedup_key=f"{source}:{article_key}:{MARKET_SYMBOL}:macro",
                )
            )

        rule = next(
            ((kind, severity) for kind, severity, pattern in _KIND_RULES if pattern.search(text)),
            None,
        )
        if rule is None:
            continue
        kind, severity = rule
        assets = detect_event_assets(text, extra_tickers)
        if not assets:
            continue
        # Multi-asset listicles are about the format, not the tokens. A
        # genuine multi-asset story (e.g. an exploit hitting several tokens)
        # survives — its headline doesn't read like a roundup.
        if len(assets) >= _ROUNDUP_MIN_ASSETS and _ROUNDUP_HEADLINE_RE.search(item.headline):
            continue
        # Info-severity kinds (listings, upgrades) are only worth recording
        # when the token is the story: require the mention in the headline
        # itself. Critical/warning kinds keep the wider net.
        headline_assets = (
            set(detect_event_assets(item.headline, extra_tickers)) if severity == "info" else None
        )

        for symbol in assets:
            if headline_assets is not None and symbol not in headline_assets:
                continue
            events.append(
                TokenEventInput(
                    symbol=symbol,
                    kind=kind,
                    severity=severity,
                    title=item.headline,
                    body=item.description or None,
                    source=source,
                    url=item.url,
                    published_at=published_at,
                    dedup_key=f"{source}:{article_key}:{symbol}:{kind}",
                )
            )
    return events
