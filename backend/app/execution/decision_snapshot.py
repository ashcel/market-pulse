import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import Float, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class DecisionSnapshot(Base):
    """Point-in-time advice shown before a user decides whether to trade."""

    __tablename__ = "decision_snapshots"
    __table_args__ = (
        sa.Index("decision_snapshots_user_id_created_at_idx", "user_id", "created_at"),
        sa.Index("decision_snapshots_user_id_action_idx", "user_id", "user_action"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    symbol: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    objective: Mapped[str] = mapped_column(String(20), nullable=False)
    direction: Mapped[str] = mapped_column(String(10), nullable=False)
    verdict_at_time: Mapped[str] = mapped_column(String(50), nullable=False)
    catalyst_modifier: Mapped[dict[str, Any] | None] = mapped_column(sa.JSON, nullable=True)
    skip_check_result: Mapped[dict[str, Any] | None] = mapped_column(sa.JSON, nullable=True)
    entry_zone: Mapped[dict[str, Any] | None] = mapped_column(sa.JSON, nullable=True)
    stop_loss: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit: Mapped[float | None] = mapped_column(Float, nullable=True)
    user_action: Mapped[str | None] = mapped_column(String(30), nullable=True, index=True)
    actual_outcome: Mapped[dict[str, Any] | None] = mapped_column(sa.JSON, nullable=True)
    engine_version: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
    decided_at: Mapped[datetime | None] = mapped_column(nullable=True)
