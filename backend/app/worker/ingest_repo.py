"""Persistence for the ingestion passes (token events, breadth snapshots,
catalyst calendar, ingest bookkeeping) — mirror of the legacy TS repo
semantics over the same legacy-owned tables. Idempotency lives in the
schema: token_event/catalyst_event dedup on their unique dedup_key.
"""

import json
from dataclasses import asdict
from datetime import datetime
from typing import cast

from smc.catalyst_events import CatalystEventInput
from smc.econ_events import EconEventInput
from smc.external_context import MarketContextSnapshotInput
from smc.token_events import TokenEventInput
from sqlalchemy import CursorResult, DateTime, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def insert_token_events(db: AsyncSession, events: list[TokenEventInput]) -> int:
    """Idempotent bulk insert — the dedup unique index makes re-ingestion a no-op."""
    inserted = 0
    stmt = text(
        "insert into token_event"
        " (symbol, kind, severity, title, body, source, url, published_at, dedup_key)"
        " values (:symbol, :kind, :severity, :title, :body, :source, :url,"
        " :published_at, :dedup_key)"
        " on conflict (dedup_key) do nothing"
    ).bindparams(bindparam("published_at", type_=DateTime(timezone=True)))
    for e in events:
        result = await db.execute(
            stmt,
            {
                "symbol": e.symbol,
                "kind": e.kind,
                "severity": e.severity,
                "title": e.title,
                "body": e.body,
                "source": e.source,
                "url": e.url,
                "published_at": _parse_iso(e.published_at),
                "dedup_key": e.dedup_key,
            },
        )
        inserted += cast("CursorResult[object]", result).rowcount or 0
    await db.commit()
    return inserted


async def upsert_ingest_state(
    db: AsyncSession, source: str, status: str, error: str | None = None
) -> None:
    """Record the outcome of one ingest attempt. ``ok`` refreshes last_ok_at
    and clears nothing (the last error stays visible for postmortems);
    ``error`` keeps last_ok_at so staleness can be computed from when data
    was last good."""
    if status == "ok":
        await db.execute(
            text(
                "insert into ingest_state (source, status, last_ok_at)"
                " values (:source, 'ok', now())"
                " on conflict (source) do update"
                " set status = 'ok', last_ok_at = now(), updated_at = now()"
            ),
            {"source": source},
        )
    else:
        await db.execute(
            text(
                "insert into ingest_state (source, status, last_error, last_error_at)"
                " values (:source, :status, :error,"
                " case when :status = 'error' then now() end)"
                " on conflict (source) do update"
                " set status = :status,"
                " last_error = coalesce(:error, ingest_state.last_error),"
                " last_error_at = case when :status = 'error' then now()"
                " else ingest_state.last_error_at end,"
                " updated_at = now()"
            ),
            {"source": source, "status": status, "error": error},
        )
    await db.commit()


async def insert_market_context_snapshot(
    db: AsyncSession, snapshot: MarketContextSnapshotInput
) -> None:
    await db.execute(
        text(
            "insert into market_context_snapshot"
            " (total_mcap_usd, btc_dominance, eth_dominance, mcap_change_24h_pct, source)"
            " values (:total_mcap_usd, :btc_dominance, :eth_dominance,"
            " :mcap_change_24h_pct, :source)"
        ),
        asdict(snapshot),
    )
    await db.commit()


async def upsert_catalyst_events(db: AsyncSession, events: list[CatalystEventInput]) -> int:
    """Reschedule-aware upsert: a moved date updates the existing row.
    Credibility keys stay camelCase — the legacy web read models parse them."""
    written = 0
    stmt = text(
        "insert into catalyst_event"
        " (symbol, kind, title, description, occurs_at, source, source_id, url,"
        " credibility, percent_of_supply, dedup_key)"
        " values (:symbol, :kind, :title, :description, :occurs_at, :source,"
        " :source_id, :url, cast(:credibility as jsonb), :percent_of_supply, :dedup_key)"
        " on conflict (dedup_key) do update set"
        " occurs_at = excluded.occurs_at,"
        " title = excluded.title,"
        " description = excluded.description,"
        " url = excluded.url,"
        " credibility = excluded.credibility,"
        " percent_of_supply = excluded.percent_of_supply,"
        " updated_at = now()"
    ).bindparams(bindparam("occurs_at", type_=DateTime(timezone=True)))
    for e in events:
        credibility = (
            None
            if e.credibility is None
            else json.dumps(
                {
                    "votes": e.credibility.votes,
                    "confidencePct": e.credibility.confidence_pct,
                    "hotScore": e.credibility.hot_score,
                }
            )
        )
        result = await db.execute(
            stmt,
            {
                "symbol": e.symbol,
                "kind": e.kind,
                "title": e.title,
                "description": e.description,
                "occurs_at": _parse_iso(e.occurs_at),
                "source": e.source,
                "source_id": e.source_id,
                "url": e.url,
                "credibility": credibility,
                "percent_of_supply": e.percent_of_supply,
                "dedup_key": e.dedup_key,
            },
        )
        written += cast("CursorResult[object]", result).rowcount or 0
    await db.commit()
    return written


async def upsert_economic_events(db: AsyncSession, events: list[EconEventInput]) -> int:
    """Idempotent upsert of ForexFactory macro-calendar rows. DO UPDATE (not
    do-nothing) so a forecast/previous/impact revision from a later re-fetch
    wins — ForexFactory tweaks estimates as a release nears. The dedup key
    already pins (source, country, title, feed-date), so a genuine reschedule
    (date change) lands as a new row, mirroring catalyst_event's semantics."""
    written = 0
    stmt = text(
        "insert into economic_event"
        " (title, country, impact, forecast, previous, occurs_at, source, dedup_key)"
        " values (:title, :country, :impact, :forecast, :previous, :occurs_at,"
        " :source, :dedup_key)"
        " on conflict (dedup_key) do update set"
        " impact = excluded.impact,"
        " forecast = excluded.forecast,"
        " previous = excluded.previous,"
        " occurs_at = excluded.occurs_at,"
        " updated_at = now()"
    ).bindparams(bindparam("occurs_at", type_=DateTime(timezone=True)))
    for e in events:
        result = await db.execute(
            stmt,
            {
                "title": e.title,
                "country": e.country,
                "impact": e.impact,
                "forecast": e.forecast,
                "previous": e.previous,
                "occurs_at": _parse_iso(e.occurs_at),
                "source": e.source,
                "dedup_key": e.dedup_key,
            },
        )
        written += cast("CursorResult[object]", result).rowcount or 0
    await db.commit()
    return written


async def prune_economic_events(db: AsyncSession, older_than_iso: str) -> int:
    result = await db.execute(
        text("delete from economic_event where occurs_at < :cutoff").bindparams(
            bindparam("cutoff", type_=DateTime(timezone=True))
        ),
        {"cutoff": _parse_iso(older_than_iso)},
    )
    await db.commit()
    return cast("CursorResult[object]", result).rowcount or 0


async def prune_market_context_snapshots(db: AsyncSession, older_than_iso: str) -> int:
    result = await db.execute(
        text("delete from market_context_snapshot where fetched_at < :cutoff").bindparams(
            bindparam("cutoff", type_=DateTime(timezone=True))
        ),
        {"cutoff": _parse_iso(older_than_iso)},
    )
    await db.commit()
    return cast("CursorResult[object]", result).rowcount or 0


async def prune_catalyst_events(db: AsyncSession, older_than_iso: str) -> int:
    result = await db.execute(
        text("delete from catalyst_event where occurs_at < :cutoff").bindparams(
            bindparam("cutoff", type_=DateTime(timezone=True))
        ),
        {"cutoff": _parse_iso(older_than_iso)},
    )
    await db.commit()
    return cast("CursorResult[object]", result).rowcount or 0


# ── Unlock scope + slug-resolution cache ────────────────────────────────────


async def load_unlock_scope(db: AsyncSession) -> list[str]:
    """Tickers to fetch unlock calendars for beyond WORKER_UNIVERSE: every
    opened (tracked_token) and starred (user_watchlist) token. Uppercased and
    de-duplicated; the pass unions these with the fixed universe."""
    result = await db.execute(
        text(
            "select ticker from tracked_token"
            " union select symbol from user_watchlist"
        )
    )
    return sorted({str(row[0]).upper() for row in result.all() if row[0]})


async def get_slug_cache(db: AsyncSession, ticker: str) -> tuple[str | None, datetime] | None:
    """Cached (slug, checked_at) for a ticker, or None if never resolved. A
    non-None row with slug=None is a cached negative ('no unlock schedule')."""
    result = await db.execute(
        text("select slug, checked_at from unlock_slug_cache where ticker = :t"),
        {"t": ticker.upper()},
    )
    row = result.first()
    if row is None:
        return None
    return row[0], row[1]


async def upsert_slug_cache(
    db: AsyncSession, ticker: str, gecko_id: str | None, slug: str | None
) -> None:
    await db.execute(
        text(
            "insert into unlock_slug_cache (ticker, gecko_id, slug, checked_at)"
            " values (:t, :g, :s, now())"
            " on conflict (ticker) do update set"
            " gecko_id = excluded.gecko_id, slug = excluded.slug, checked_at = now()"
        ),
        {"t": ticker.upper(), "g": gecko_id, "s": slug},
    )
    await db.commit()
