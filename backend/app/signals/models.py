"""`signal_events` — the append-only record of every signal any source
detected (docs/IMPLEMENTATION-PLAN.md §2.1).

Shipped in Sprint 2 as a *subset* of the full Opus contract; Sprint 5 added
the two deferred columns (`status`, `context_ref`) now that a second source is
allowed to write. What was never deferred is `dedup_key` UNIQUE — that is what
makes an append-only table safe under retry, and the 48h reconciliation in
the Sprint 2 exit criteria counts on it.

`status` is the per-row twin of the `SIGNAL_SOURCES_LIVE` allowlist: a new
source writes `shadow` rows that are recorded but never surfaced, and is
promoted to `live` only by its `source_scorecard` numbers. The allowlist stays
the operator-facing kill switch; the column is what lets one source be live
while another is still proving itself.

A correction to a signal is a NEW event, never an update: the DB trigger
installed by the migration raises `signal_events is append-only` on any
UPDATE or DELETE.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# JSONB in Postgres (the only place this ships), plain JSON under the sqlite
# used by the unit tests — the payload is stored verbatim either way.
FeaturesJSON = sa.JSON().with_variant(JSONB, "postgresql")


class SignalEvent(Base):
    __tablename__ = "signal_events"
    __table_args__ = (
        sa.UniqueConstraint("dedup_key", name="signal_events_dedup_key_key"),
        sa.Index("signal_events_symbol_detected_idx", "symbol", sa.text("detected_at DESC")),
        sa.Index("signal_events_detected_idx", sa.text("detected_at DESC")),
        sa.Index("signal_events_source_idx", "source", "source_version"),
        sa.Index("signal_events_status_idx", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # 'quant' | 'smc' | 'tradeway'
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    # provenance: short git sha for external writers, '2.0.0' for the engine
    source_version: Mapped[str] = mapped_column(String(32), nullable=False)
    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    # 'long' | 'short'
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    # 'scalp' | 'intraday' | 'swing' | 'position'
    horizon: Mapped[str] = mapped_column(String(16), nullable=False)
    # detector id: 'ma-alignment', 'bos-bullish', ...
    kind: Mapped[str] = mapped_column(String(48), nullable=False)
    # 'low' | 'medium' | 'high' | 'very_high' (nullable: not every source rates)
    conviction: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # When the SOURCE detected it — never the ingest clock (see R3: scorecards
    # may only ever be built from live detection times).
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The source's own payload, stored uninterpreted.
    features: Mapped[dict[str, Any]] = mapped_column(
        FeaturesJSON, nullable=False, server_default=sa.text("'{}'"), default=dict
    )
    # '{source}|{symbol}|{side}|{horizon}|{YYYY-MM-DD}|{kind}', optionally with
    # a trailing '|{state}' for stateful patterns (e.g. reaccumulation's
    # ACCUMULATING/SECOND_EXPANSION) so a same-day state transition writes a
    # new row instead of colliding with the day's earlier read.
    dedup_key: Mapped[str] = mapped_column(String(255), nullable=False)
    # 'shadow' | 'live' (Sprint 5). Recorded either way; only 'live' rows are
    # eligible to surface. Existing rows were backfilled to 'live' by the
    # migration's server_default — they are the source that already earned it.
    status: Mapped[str] = mapped_column(
        String(8), nullable=False, server_default=sa.text("'live'"), default="live"
    )
    # Optional snapshot of the market context at detection time (regime, etc).
    # Nullable on purpose: it is derivable from `detected_at`, so a source that
    # does not carry one is not wrong, only slower to join.
    context_ref: Mapped[dict[str, Any] | None] = mapped_column(FeaturesJSON, nullable=True)
    # Python default as well as the server default: the sqlite used by the
    # unit tests has no now().
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=sa.text("now()"),
        default=lambda: datetime.now(UTC),
    )
