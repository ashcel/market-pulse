import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TradeReview(Base):
    __tablename__ = "trade_reviews"
    __table_args__ = (
        sa.Index("trade_reviews_bybit_trade_id_version_idx", "bybit_trade_id", "version"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    bybit_trade_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    review_mode: Mapped[str] = mapped_column(String(20), default="normal", nullable=False)
    severity_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    severity_tier: Mapped[str] = mapped_column(String(20), default="MILD", nullable=False)
    grade: Mapped[str | None] = mapped_column(String(5), nullable=True)
    one_liner: Mapped[str | None] = mapped_column(Text, nullable=True)
    full_review: Mapped[dict[str, Any]] = mapped_column(sa.JSON, nullable=False)
    model_used: Mapped[str | None] = mapped_column(String(100), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
