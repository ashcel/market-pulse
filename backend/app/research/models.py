"""FORWARD-TEST persistence for the Discover scanner.

Two tables, normalized the way the research question is asked:

* `forward_test_setups` — one row per hypothesis. The immutable plan captured
  at detection, plus the lifecycle state and the final outcome.
* `forward_test_events` — the append-only lifecycle. Rows are inserted, never
  updated, so the story of a setup survives even where the summary row has
  moved on.

Deliberately separate from `app.forward_test`, which is the *engine's* shadow
record plane at ENGINE_VERSION 2.0.0. Different detector, different hypothesis,
different question — pooling them would make both datasets meaningless.

## What is not stored

Ticks. The scanner observes at ~1s and evaluates every 2s; writing that would
be millions of rows a day carrying no information. Only meaningful state
transitions and settlement land here, which is also what keeps Postgres out of
the radar's hot path (see CLAUDE.md).

## Immutability in practice

The detection-time columns (`detected_at` through `potential_rr`, plus
`evidence` and the provenance block) are written once by the recorder and never
included in an update statement. That is enforced in `repo.py`, which has a
single narrow `update_lifecycle` that touches only lifecycle and outcome
columns.
"""

import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import Boolean, DateTime, Double, ForeignKey, Index, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# JSONB in Postgres (the only place this ships), plain JSON under the sqlite
# used by the unit tests — same code path, same repo, both dialects.
ResearchJSON = sa.JSON().with_variant(JSONB, "postgresql")
ResearchUUID = sa.String(36).with_variant(UUID(as_uuid=False), "postgresql")


def _new_id() -> str:
    """Ids are generated here rather than by a server default so the model's
    DDL stays dialect-portable; the Postgres migration keeps its own
    `gen_random_uuid()` default for anything inserting outside the app."""
    return str(uuid.uuid4())


class ForwardTestSetup(Base):
    """One recorded hypothesis and what became of it."""

    __tablename__ = "forward_test_setups"
    __table_args__ = (
        Index("forward_test_setups_symbol_idx", "symbol"),
        Index("forward_test_setups_mode_idx", "mode"),
        Index("forward_test_setups_status_idx", "status"),
        Index("forward_test_setups_detected_at_idx", "detected_at"),
        Index("forward_test_setups_strategy_idx", "strategy_version", "config_hash"),
        # The read model's default query: newest first within a mode/status.
        Index("forward_test_setups_feed_idx", "mode", "status", "detected_at"),
        # Segmenting outcomes by the tape they happened in.
        Index("forward_test_setups_regime_idx", "regime", "mode"),
    )

    id: Mapped[str] = mapped_column(ResearchUUID, primary_key=True, default=_new_id)
    # Stable identity for deduplication: one situation produces one row, however
    # many times the scanner polls it.
    setup_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)

    symbol: Mapped[str] = mapped_column(Text, nullable=False)
    market: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)

    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # ── the setup as it read at detection (never updated) ────────────────────
    state: Mapped[str] = mapped_column(Text, nullable=False)
    tier: Mapped[str] = mapped_column(Text, nullable=False)
    combo: Mapped[str] = mapped_column(Text, nullable=False, default="")
    score: Mapped[float] = mapped_column(Double, nullable=False)
    families: Mapped[list[str] | None] = mapped_column(ResearchJSON, nullable=True)

    entry_low: Mapped[float] = mapped_column(Double, nullable=False)
    entry_high: Mapped[float] = mapped_column(Double, nullable=False)
    reference_entry: Mapped[float] = mapped_column(Double, nullable=False)
    initial_invalidation: Mapped[float] = mapped_column(Double, nullable=False)
    target: Mapped[float] = mapped_column(Double, nullable=False)
    target_kind: Mapped[str] = mapped_column(Text, nullable=False, default="")
    potential_rr: Mapped[float] = mapped_column(Double, nullable=False)

    htf_bias: Mapped[str] = mapped_column(Text, nullable=False)
    htf_agreement: Mapped[float] = mapped_column(Double, nullable=False)
    alignment: Mapped[str] = mapped_column(Text, nullable=False)
    alignment_level: Mapped[str] = mapped_column(Text, nullable=False)
    structure_trend: Mapped[str] = mapped_column(Text, nullable=False)
    # What the whole market was doing at detection — bullish / bearish / choppy
    # / unknown. A column rather than a key in `evidence` because every stats
    # cut will want to segment by it; the numbers behind the label stay in
    # `evidence`. Rows written before this shipped are NULL, which is not the
    # same claim as "unknown".
    regime: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Everything else observed at detection: windows, rvol, retracement,
    # completion evidence. One JSONB blob because it is read as a unit and
    # never queried field-by-field.
    evidence: Mapped[dict[str, Any] | None] = mapped_column(ResearchJSON, nullable=True)

    # ── provenance (never updated) ───────────────────────────────────────────
    strategy_version: Mapped[str] = mapped_column(Text, nullable=False)
    engine_version: Mapped[str] = mapped_column(Text, nullable=False)
    config_hash: Mapped[str] = mapped_column(Text, nullable=False)
    git_sha: Mapped[str] = mapped_column(Text, nullable=False)
    versions: Mapped[dict[str, Any] | None] = mapped_column(ResearchJSON, nullable=True)

    # ── lifecycle ────────────────────────────────────────────────────────────
    zone_touched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    entered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    entry_price: Mapped[float | None] = mapped_column(Double, nullable=True)
    # The stop in force. `initial_invalidation` above is never touched.
    active_stop: Mapped[float] = mapped_column(Double, nullable=False)
    trailing_mode: Mapped[str] = mapped_column(Text, nullable=False)
    trailing_activated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    trailing_updates: Mapped[list[Any] | None] = mapped_column(ResearchJSON, nullable=True)

    # Which detector arms (`smc.arms`) would have taken this setup, frozen at
    # detection alongside everything else on this row. A detector arm changes
    # *which* setups exist, so it cannot be settled forward the way an exit or
    # plan arm is; it is stamped here and read as a subset by the weekly report.
    arm_flags: Mapped[dict[str, Any] | None] = mapped_column(ResearchJSON, nullable=True)

    # ── outcome ──────────────────────────────────────────────────────────────
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_price: Mapped[float | None] = mapped_column(Double, nullable=True)
    exit_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    realized_r: Mapped[float] = mapped_column(Double, nullable=False, default=0.0)
    # Before costs, and what the round trip took — kept apart so a different
    # cost assumption can be re-derived without replaying the tape.
    gross_r: Mapped[float] = mapped_column(Double, nullable=False, default=0.0)
    cost_r: Mapped[float] = mapped_column(Double, nullable=False, default=0.0)
    # What alternative exit rules would have produced on this same setup.
    variants: Mapped[dict[str, Any] | None] = mapped_column(ResearchJSON, nullable=True)
    # The tape at settlement. Separate from `regime` because the interesting
    # case is the trade that opened in a trend and closed in chop — one field
    # could never show it.
    exit_regime: Mapped[str | None] = mapped_column(Text, nullable=True)
    mfe_pct: Mapped[float] = mapped_column(Double, nullable=False, default=0.0)
    mae_pct: Mapped[float] = mapped_column(Double, nullable=False, default=0.0)
    mfe_r: Mapped[float] = mapped_column(Double, nullable=False, default=0.0)
    mae_r: Mapped[float] = mapped_column(Double, nullable=False, default=0.0)
    pending_mfe_pct: Mapped[float] = mapped_column(
        Double, nullable=False, default=0.0
    )
    pending_mae_pct: Mapped[float] = mapped_column(
        Double, nullable=False, default=0.0
    )
    touched_zone: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0.0)

    last_price: Mapped[float] = mapped_column(Double, nullable=False, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa.func.now()
    )


class ForwardTestEvent(Base):
    """One lifecycle transition. Insert-only — nothing here is ever revised."""

    __tablename__ = "forward_test_events"
    __table_args__ = (
        Index("forward_test_events_setup_idx", "setup_id", "ts"),
        Index("forward_test_events_type_idx", "type"),
    )

    id: Mapped[str] = mapped_column(ResearchUUID, primary_key=True, default=_new_id)
    setup_id: Mapped[str] = mapped_column(
        ResearchUUID,
        ForeignKey("forward_test_setups.id", ondelete="CASCADE"),
        nullable=False,
    )
    type: Mapped[str] = mapped_column(Text, nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    price: Mapped[float] = mapped_column(Double, nullable=False)
    detail: Mapped[dict[str, Any] | None] = mapped_column(ResearchJSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa.func.now()
    )
