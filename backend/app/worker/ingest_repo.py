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
