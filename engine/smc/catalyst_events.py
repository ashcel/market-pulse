"""CoinMarketCal → catalyst_event normalization. Pure and fixture-testable:
the worker's context pass fetches, this file decides what qualifies.

Filtering philosophy (high-signal over volume):
- Coins are mapped by PROVIDER ID via asset_ids.py; unmapped coins drop.
- A credibility gate keeps only events with a proof link, enough votes, or
  high provider confidence — the crowd-sourced tail is noise by default.
- percent_of_supply stays None on the free tier: the prompt layer must then
  present an unlock as a scheduling fact, never a supply-pressure signal.

Port of catalyst-events.ts.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Literal

from smc.asset_ids import TICKER_BY_COINMARKETCAL_ID

CatalystKind = Literal["unlock", "listing", "upgrade", "fork", "burn", "other"]


@dataclass(slots=True)
class CatalystCredibility:
    votes: float | None
    confidence_pct: float | None
    hot_score: float | None


@dataclass(slots=True)
class CatalystEventInput:
    symbol: str
    kind: CatalystKind
    title: str
    description: str | None
    occurs_at: str
    source: str
    source_id: str | None
    url: str | None
    credibility: CatalystCredibility | None
    percent_of_supply: float | None
    dedup_key: str


# Category name → kind, first match wins. Checked lowercase-inclusive so
# "Token Unlock", "Unlocks" and "unlock" all land the same place.
_KIND_BY_CATEGORY: list[tuple[re.Pattern[str], CatalystKind]] = [
    (re.compile(r"unlock|vesting"), "unlock"),
    (re.compile(r"listing|exchange"), "listing"),
    (re.compile(r"fork|swap"), "fork"),
    (re.compile(r"burn"), "burn"),
    (re.compile(r"release|update|upgrade|mainnet|testnet|hard fork"), "upgrade"),
]

_MIN_VOTES = 15
_MIN_CONFIDENCE_PCT = 80


def _as_string(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    # CoinMarketCal titles/descriptions arrive as { en: "..." }.
    if isinstance(value, dict):
        en = value.get("en")
        if isinstance(en, str) and en.strip():
            return en.strip()
    return None


def _as_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def _classify_kind(categories: object) -> CatalystKind:
    if isinstance(categories, list):
        names = " ".join(
            _as_string(c.get("name")) or "" for c in categories if isinstance(c, dict)
        ).lower()
    else:
        names = ""
    for pattern, kind in _KIND_BY_CATEGORY:
        if pattern.search(names):
            return kind
    return "other"


def passes_credibility_gate(
    url: str | None, votes: float | None, confidence_pct: float | None
) -> bool:
    """Proof link OR enough votes OR high provider confidence — else noise."""
    if url:
        return True
    if votes is not None and votes >= _MIN_VOTES:
        return True
    return confidence_pct is not None and confidence_pct >= _MIN_CONFIDENCE_PCT


def _parse_date_ms(value: str | None) -> float:
    if not value:
        return math.nan
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        pass
    try:
        return parsedate_to_datetime(value).timestamp() * 1000
    except (TypeError, ValueError):
        return math.nan


def normalize_coinmarketcal_events(payload: object, now_ms: float) -> list[CatalystEventInput]:
    """Normalize one CoinMarketCal ``/v1/events`` response page. Events fan out
    one row per mapped coin; a whole-payload shape surprise returns [] (the
    caller records an ingest error when the fetch failed — an empty page is
    valid)."""
    body = payload.get("body") if isinstance(payload, dict) else None
    if not isinstance(body, list):
        return []
    out: list[CatalystEventInput] = []
    for raw in body:
        if not isinstance(raw, dict):
            continue
        title = _as_string(raw.get("title"))
        occurs_at_ms = _parse_date_ms(_as_string(raw.get("date_event")))
        if not title or not math.isfinite(occurs_at_ms):
            continue
        # Past events (beyond a day of timezone slack) are not "what matters next".
        if occurs_at_ms < now_ms - 24 * 60 * 60_000:
            continue

        source_id = _as_string(raw.get("id"))
        if source_id is None:
            id_num = _as_number(raw.get("id"))
            source_id = str(int(id_num)) if id_num is not None else None
        url = _as_string(raw.get("proof")) or _as_string(raw.get("source"))
        votes = _as_number(raw.get("vote_count"))
        confidence_pct = _as_number(raw.get("percentage"))
        hot_score = _as_number(raw.get("hot_index"))
        if hot_score is None:
            hot_score = _as_number(raw.get("trending_index"))
        if not passes_credibility_gate(url, votes, confidence_pct):
            continue

        kind = _classify_kind(raw.get("categories"))
        coins = raw.get("coins")
        occurs_at = (
            datetime.fromtimestamp(occurs_at_ms / 1000, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        for coin in coins if isinstance(coins, list) else []:
            provider_id = _as_string(coin.get("id")) if isinstance(coin, dict) else None
            symbol = TICKER_BY_COINMARKETCAL_ID.get(provider_id) if provider_id else None
            if symbol is None:
                continue  # unmapped coin — dropped by design
            article_key = source_id if source_id is not None else f"{title}:{int(occurs_at_ms)}"
            out.append(
                CatalystEventInput(
                    symbol=symbol,
                    kind=kind,
                    title=title,
                    description=_as_string(raw.get("description")),
                    occurs_at=occurs_at,
                    source="coinmarketcal",
                    source_id=source_id,
                    url=url,
                    credibility=CatalystCredibility(
                        votes=votes, confidence_pct=confidence_pct, hot_score=hot_score
                    ),
                    percent_of_supply=None,  # not exposed on the free tier
                    dedup_key=f"coinmarketcal:{article_key}:{symbol}",
                )
            )
    return out
