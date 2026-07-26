"""Live-only, append-only market context observed while a position is open."""

import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.review.models import JSON_TYPE


class TradeContext(Base):
    """One immutable stamp per position episode (docs/forensics-definitions.md §8).

    The episode identity is `(user_id, symbol, side, first_seen_at)` and the row
    is written on **first observation only**. Nothing here is ever reconstructed
    from a `BinanceTrade` row — that table holds closed trades, and a stamp
    assembled after the close would be a claim about the past, not evidence that
    the system read this at that moment.

    `last_seen_at` is episode bookkeeping (how long the position stayed open),
    not a context field; it is the only column that may be updated. Every
    context field is corrected by inserting a new row with `supersedes_id`.
    """

    __tablename__ = "trade_contexts"
    __table_args__ = (
        sa.UniqueConstraint(
            "user_id", "symbol", "side", "first_seen_at", name="trade_contexts_episode_key"
        ),
        sa.Index("trade_contexts_open_episode_idx", "user_id", "symbol", "side", "last_seen_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    symbol: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    side: Mapped[str] = mapped_column(String(10), nullable=False)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    stamped_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    observation_source: Mapped[str] = mapped_column(String(20), nullable=False)
    observation_lag_bound_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    supersedes_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("trade_contexts.id"), nullable=True
    )

    regime: Mapped[str | None] = mapped_column(String(50), nullable=True)
    verdicts_at_open: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON_TYPE, nullable=True)
    verdict_source: Mapped[str] = mapped_column(String(20), nullable=False)
    eval_log_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    eval_evaluated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    eval_staleness_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    engine_version: Mapped[str | None] = mapped_column(String(20), nullable=True)
    config_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    git_sha: Mapped[str | None] = mapped_column(String(64), nullable=True)

    session: Mapped[str] = mapped_column(String(20), nullable=False)
    catalysts: Mapped[list[dict[str, Any]]] = mapped_column(JSON_TYPE, nullable=False, default=list)
    catalyst_top: Mapped[dict[str, Any] | None] = mapped_column(JSON_TYPE, nullable=True)

    forensics_version: Mapped[str] = mapped_column(String(20), nullable=False, default="1.0.0")
    impact_score_version: Mapped[str] = mapped_column(String(20), nullable=False, default="1.0.0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(), nullable=False
    )
