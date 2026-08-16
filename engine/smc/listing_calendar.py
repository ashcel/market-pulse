"""New-listing calendar — parsing Binance's own announcement feed into dated,
symbol-tagged listing events.

Binance publishes every listing as a CMS article (catalog 48, "New
Cryptocurrency Listing"). The *title* carries the venue and the tickers; the
*body* carries the exact launch time in UTC. Both are free text, so this
module is deliberately conservative: a title it cannot confidently classify
yields `venue=OTHER` with no symbols rather than a guess, and the caller drops
it. A wrong ticker here would put a token on a buy-screener that Binance never
listed — the expensive failure — while a missed one only costs a row.

Most of the feed is *not* a crypto listing: TradFi perpetuals, bStocks
tokenized equities, collateral-asset notices, margin-pair additions and
quarterly delivery contracts all share the catalog. `is_noise` rejects those
by vocabulary, and the rejection reason is kept so the funnel stays legible.

This is a discovery layer, like `discovery.py` — it never touches decision or
trigger semantics, so it carries its own version and never ENGINE_VERSION.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Literal

LISTING_CALENDAR_VERSION = "1.0.0"

# Where the listing happens. ALPHA is never announced through this catalog —
# it is discovered from the Alpha token feed — but the enum carries it so one
# venue vocabulary serves the whole plane.
Venue = Literal["SPOT", "FUTURES", "ALPHA", "HODLER_AIRDROP", "OTHER"]

ANNOUNCEMENT_URL = "https://www.binance.com/en/support/announcement/{code}"

# Vocabulary that marks an article as something other than a crypto listing.
# Checked case-insensitively against the title, most-specific first so the
# rejection reason names the actual reason.
_NOISE_PATTERNS: tuple[tuple[str, str], ...] = (
    ("tradfi", "tradfi_perpetual"),
    ("bstocks", "tokenized_equity"),
    ("tokenized securities", "tokenized_equity"),
    ("stock trading", "tokenized_equity"),
    ("pre-ipo", "pre_ipo"),
    ("collateral asset", "collateral_notice"),
    ("delivery contract", "delivery_contract"),
    ("margin will add", "margin_pairs"),
    ("trading bots services", "bot_services"),
    ("zero maker fee", "fee_promotion"),
    ("delist", "delisting"),
    ("will remove", "delisting"),
)

# Quote assets Binance appends to a futures contract symbol. Ordered longest
# first so USDT is not stripped off the front of a USDT-quoted base.
_QUOTES = ("USDT", "USDC", "USD1", "USD")

# Bases that are a leveraged/derivative wrapper rather than a new token.
_WRAPPER_SUFFIXES = ("UP", "DOWN", "BULL", "BEAR")

# Tickers that appear parenthesised in listing titles but are never the
# listed asset itself.
_TICKER_STOPWORDS = frozenset(
    {"UTC", "USD", "USDT", "USDC", "BNB", "API", "ETF", "VIP", "AED", "JPY"}
)

_DATE_IN_TITLE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_PAREN_TICKER = re.compile(r"\(([A-Z][A-Z0-9]{1,11})\)")
_FUTURES_CONTRACT = re.compile(r"\b([A-Z][A-Z0-9]{1,14})(?:USDT|USDC|USD1)\b")
_UTC_TIMESTAMP = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*\(?UTC\)?",
    re.IGNORECASE,
)


@dataclass(slots=True)
class ListingAnnouncement:
    """One parsed article from the listing catalog."""

    code: str
    title: str
    url: str
    published_at: datetime
    venue: Venue
    # Base assets the article lists, e.g. ["DOS"]. Empty for OTHER/noise and
    # for the "Multiple ... Contracts" bulk articles that name no ticker.
    symbols: list[str] = field(default_factory=list)
    # Exact launch time, only ever read from the article body.
    listing_at: datetime | None = None
    # Calendar date parsed from the title — coarser than `listing_at`, and the
    # only date available before the body is fetched.
    listing_date: date | None = None
    # Binance's Seed Tag: an explicitly higher-risk, early-stage listing.
    seed_tag: bool = False
    # Set when the article is not a crypto listing; `venue` is OTHER.
    rejected_because: str | None = None

    @property
    def is_listing(self) -> bool:
        return self.rejected_because is None and self.venue != "OTHER" and bool(self.symbols)


def is_noise(title: str) -> str | None:
    """Reason this title is not a crypto listing, or None if it might be."""
    lowered = title.lower()
    for needle, reason in _NOISE_PATTERNS:
        if needle in lowered:
            return reason
    return None


def classify_venue(title: str) -> Venue:
    lowered = title.lower()
    if "hodler airdrop" in lowered:
        return "HODLER_AIRDROP"
    if "binance alpha" in lowered:
        return "ALPHA"
    if "futures will" in lowered or "perpetual contract" in lowered:
        return "FUTURES"
    if "will list" in lowered or ("adds" in lowered and "spot" in lowered):
        return "SPOT"
    if "will open trading" in lowered or "new trading pairs" in lowered:
        return "SPOT"
    return "OTHER"


def _clean_base(base: str) -> str | None:
    if base in _TICKER_STOPWORDS or len(base) < 2:
        return None
    if any(base.endswith(suffix) and len(base) > len(suffix) + 1 for suffix in _WRAPPER_SUFFIXES):
        return None
    return base


def extract_symbols(title: str, venue: Venue) -> list[str]:
    """Base assets named in the title, de-duplicated, order preserved.

    Futures titles name the *contract* (`DOSUSDT`), spot/airdrop titles name
    the asset parenthesised after its full name (`DAppOS (DOS)`). Bulk
    articles ("Multiple ... Contracts") name nothing and correctly yield [].
    """
    found: list[str] = []

    def push(candidate: str) -> None:
        base = _clean_base(candidate)
        if base and base not in found:
            found.append(base)

    if venue == "FUTURES":
        for match in _FUTURES_CONTRACT.finditer(title):
            push(match.group(1))
        # A futures title may also carry the underlying parenthesised.
        if not found:
            for match in _PAREN_TICKER.finditer(title):
                push(match.group(1))
        return found

    for match in _PAREN_TICKER.finditer(title):
        push(match.group(1))
    return found


def extract_listing_date(title: str) -> date | None:
    """The `(YYYY-MM-DD)` / `- YYYY-MM-DD` suffix Binance puts on scheduled
    articles. Returns the LAST date in the title: bulk futures titles carry
    only the launch date, while spot notices sometimes carry an "as of" date
    first and the effective date last."""
    matches = _DATE_IN_TITLE.findall(title)
    if not matches:
        return None
    year, month, day = matches[-1]
    try:
        return date(int(year), int(month), int(day))
    except ValueError:
        return None


def extract_listing_time(body_text: str) -> datetime | None:
    """Exact launch time from a flattened article body.

    Binance writes it as `2026-08-11 15:00 (UTC)`, usually twice (prose and
    spec table). The first occurrence is the launch time; later ones can be a
    funding-settlement or trading-open time for a different product in the
    same article, so this deliberately does not scan for a maximum.
    """
    match = _UTC_TIMESTAMP.search(body_text)
    if match is None:
        return None
    year, month, day, hour, minute, second = match.groups()
    try:
        return datetime(
            int(year), int(month), int(day), int(hour), int(minute), int(second or 0), tzinfo=UTC
        )
    except ValueError:
        return None


def flatten_article_body(node: Any) -> str:
    """Binance's article body is a nested `{node, tag, child}` tree; the launch
    time only exists inside its text leaves."""
    chunks: list[str] = []

    def walk(current: Any) -> None:
        if isinstance(current, dict):
            if current.get("node") == "text":
                text = current.get("text")
                if isinstance(text, str):
                    chunks.append(text)
            for child in current.get("child") or []:
                walk(child)
        elif isinstance(current, list):
            for child in current:
                walk(child)

    walk(node)
    return " ".join(chunk.strip() for chunk in chunks if chunk and chunk.strip())


def parse_announcement(article: dict[str, Any]) -> ListingAnnouncement | None:
    """One raw CMS article row -> a classified announcement.

    Returns None only when the row is structurally unusable (no title/code).
    Articles that parse but are not crypto listings come back with
    `rejected_because` set, so the caller can count the funnel instead of
    silently losing rows.
    """
    title = (article.get("title") or "").strip()
    code = (article.get("code") or "").strip()
    released = article.get("releaseDate")
    if not title or not code or not isinstance(released, (int, float)):
        return None

    published_at = datetime.fromtimestamp(released / 1000, tz=UTC)
    url = ANNOUNCEMENT_URL.format(code=code)
    noise = is_noise(title)
    if noise is not None:
        return ListingAnnouncement(
            code=code,
            title=title,
            url=url,
            published_at=published_at,
            venue="OTHER",
            rejected_because=noise,
        )

    venue = classify_venue(title)
    return ListingAnnouncement(
        code=code,
        title=title,
        url=url,
        published_at=published_at,
        venue=venue,
        symbols=extract_symbols(title, venue),
        listing_date=extract_listing_date(title),
        seed_tag="seed tag" in title.lower(),
        rejected_because=None if venue != "OTHER" else "unclassified_title",
    )


def parse_announcements(articles: list[dict[str, Any]]) -> list[ListingAnnouncement]:
    parsed = [parse_announcement(a) for a in articles]
    return [a for a in parsed if a is not None]
