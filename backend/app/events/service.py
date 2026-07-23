"""Events read model — mirrors the legacy TS repo's read queries over
`token_event` / `catalyst_event` / `economic_event` and stamps the Catalyst
Impact Score onto every row at serve time (compute-on-read; nothing is
stored, so a version bump re-scores history for free).

Row -> response mapping is split out as pure functions over plain mappings so
the scoring/serialization path is unit-testable without a database.
"""

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from .impact import EventCategory, EventImpactInput, score_event
from .schemas import (
    CatalystEventResponse,
    EconomicEventResponse,
    TokenEventResponse,
    impact_fields,
)

# ── pure row -> response mappers ────────────────────────────────────────────


def _hours_from_now(event_time: datetime, now: datetime) -> float:
    """Signed hours between now and the event (negative = already happened)."""
    return (event_time - now).total_seconds() / 3600.0


def build_token_event_response(row: Mapping[str, Any], now: datetime) -> TokenEventResponse:
    published_at: datetime = row["published_at"]
    result = score_event(
        EventImpactInput(
            category=EventCategory.NEWS,
            kind=str(row["kind"]),
            source=str(row["source"]),
            hours_from_now=_hours_from_now(published_at, now),
            severity=str(row["severity"]),
        )
    )
    return TokenEventResponse(
        id=str(row["id"]),
        symbol=row["symbol"],
        kind=row["kind"],
        severity=row["severity"],
        title=row["title"],
        body=row["body"],
        source=row["source"],
        url=row["url"],
        published_at=published_at,
        created_at=row["created_at"],
        **impact_fields(result),
    )


def _as_fraction(value: Any) -> float | None:
    """`percent_of_supply` arrives as Decimal/float/None depending on driver."""
    return None if value is None else float(value)


def _credibility_dict(value: Any) -> dict[str, Any] | None:
    """jsonb may arrive decoded (dict) or as its raw text, driver-dependent."""
    if value is None or isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def build_catalyst_event_response(row: Mapping[str, Any], now: datetime) -> CatalystEventResponse:
    occurs_at: datetime = row["occurs_at"]
    percent_of_supply = _as_fraction(row["percent_of_supply"])
    result = score_event(
        EventImpactInput(
            category=EventCategory.CATALYST,
            kind=str(row["kind"]),
            source=str(row["source"]),
            hours_from_now=_hours_from_now(occurs_at, now),
            percent_of_supply=percent_of_supply,
        )
    )
    return CatalystEventResponse(
        id=str(row["id"]),
        symbol=row["symbol"],
        kind=row["kind"],
        title=row["title"],
        description=row["description"],
        occurs_at=occurs_at,
        source=row["source"],
        source_id=row["source_id"],
        url=row["url"],
        credibility=_credibility_dict(row["credibility"]),
        percent_of_supply=percent_of_supply,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        **impact_fields(result),
    )


def build_economic_event_response(row: Mapping[str, Any], now: datetime) -> EconomicEventResponse:
    occurs_at: datetime = row["occurs_at"]
    result = score_event(
        EventImpactInput(
            category=EventCategory.ECONOMIC,
            kind="",
            source=str(row["source"]),
            hours_from_now=_hours_from_now(occurs_at, now),
            econ_impact=str(row["impact"]),
        )
    )
    return EconomicEventResponse(
        id=str(row["id"]),
        title=row["title"],
        country=row["country"],
        source_impact=row["impact"],
        forecast=row["forecast"],
        previous=row["previous"],
        occurs_at=occurs_at,
        source=row["source"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        **impact_fields(result),
    )


# ── read queries (worker-owned tables; read-only here) ──────────────────────


async def list_token_events(
    db: AsyncSession, symbol: str, limit: int = 20
) -> list[TokenEventResponse]:
    result = await db.execute(
        text(
            "select * from token_event where symbol = :symbol"
            " order by published_at desc limit :lim"
        ),
        {"symbol": symbol.upper(), "lim": limit},
    )
    now = datetime.now(UTC)
    return [build_token_event_response(r, now) for r in result.mappings().all()]


async def list_token_events_for_symbols(
    db: AsyncSession, symbols: list[str], since: datetime, limit: int = 50
) -> list[TokenEventResponse]:
    if not symbols:
        return []
    result = await db.execute(
        text(
            "select * from token_event where symbol in :symbols"
            " and published_at > :since order by published_at desc limit :lim"
        ).bindparams(bindparam("symbols", expanding=True)),
        {"symbols": [s.upper() for s in symbols], "since": since, "lim": limit},
    )
    now = datetime.now(UTC)
    return [build_token_event_response(r, now) for r in result.mappings().all()]


async def list_upcoming_catalysts(
    db: AsyncSession, symbol: str, until: datetime, limit: int = 10
) -> list[CatalystEventResponse]:
    result = await db.execute(
        text(
            "select * from catalyst_event where symbol = :symbol"
            " and occurs_at >= now() and occurs_at <= :until"
            " order by occurs_at asc limit :lim"
        ),
        {"symbol": symbol.upper(), "until": until, "lim": limit},
    )
    now = datetime.now(UTC)
    return [build_catalyst_event_response(r, now) for r in result.mappings().all()]


async def list_market_catalysts(
    db: AsyncSession, until: datetime, limit: int = 10
) -> list[CatalystEventResponse]:
    """Market-wide backdrop: BTC/ETH plus the reserved MARKET pseudo-symbol —
    same scope rule as the TS `listMarketCatalystEvents`."""
    result = await db.execute(
        text(
            "select * from catalyst_event where symbol in ('BTC', 'ETH', 'MARKET')"
            " and occurs_at >= now() and occurs_at <= :until"
            " order by occurs_at asc limit :lim"
        ),
        {"until": until, "lim": limit},
    )
    now = datetime.now(UTC)
    return [build_catalyst_event_response(r, now) for r in result.mappings().all()]


_ECON_TIER_RANK = {"high": 3, "medium": 2, "low": 1, "holiday": 0}


async def list_economic_events(
    db: AsyncSession, until: datetime, min_impact: str | None = None, limit: int = 100
) -> list[EconomicEventResponse]:
    tiers = list(_ECON_TIER_RANK)
    if min_impact in _ECON_TIER_RANK:
        floor = _ECON_TIER_RANK[min_impact]
        tiers = [t for t, rank in _ECON_TIER_RANK.items() if rank >= floor]
    result = await db.execute(
        text(
            "select * from economic_event where occurs_at >= now()"
            " and occurs_at <= :until and impact in :tiers"
            " order by occurs_at asc limit :lim"
        ).bindparams(bindparam("tiers", expanding=True)),
        {"until": until, "tiers": tiers, "lim": limit},
    )
    now = datetime.now(UTC)
    return [build_economic_event_response(r, now) for r in result.mappings().all()]
