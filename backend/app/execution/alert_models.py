import uuid
from datetime import UTC, datetime
from enum import StrEnum

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AlertType(StrEnum):
    ENTRY_ZONE = "entry_zone"
    VERDICT_CHANGE = "verdict_change"
    INVALIDATION = "invalidation"
    CATALYST = "catalyst"
    BEHAVIOR_COOLDOWN = "behavior_cooldown"


class AlertSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class Alert(Base):
    __tablename__ = "alerts"
    __table_args__ = (
        sa.UniqueConstraint("dedupe_key", name="alerts_dedupe_key_key"),
        sa.Index("alerts_user_id_created_at_idx", "user_id", "created_at"),
        sa.Index("alerts_user_id_read_idx", "user_id", "read"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    token_symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    body: Mapped[str] = mapped_column(sa.Text, nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False)
    read: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source_decision_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("trade_permits.id", ondelete="SET NULL"), nullable=True
    )
    # Stable event identity makes every scheduled pass safe to retry.
    dedupe_key: Mapped[str] = mapped_column(String(255), nullable=False)
