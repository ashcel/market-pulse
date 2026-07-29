import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

#: JSONB in production; plain JSON so the sqlite-backed router tests can still
#: create these tables.
JSON_TYPE = sa.JSON().with_variant(JSONB(), "postgresql")


class TradeReview(Base):
    __tablename__ = "trade_reviews"
    __table_args__ = (
        sa.Index("trade_reviews_binance_trade_id_version_idx", "binance_trade_id", "version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    binance_trade_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
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


class TradeForensics(Base):
    """One write-once measurement row per trade per `forensics_version`.

    Every metric lives in `metrics` as the §2 `MetricValue` shape — value, unit,
    availability and its reason travel together, so a missing measurement can
    never be read back as a silent null. Only the companions that describe the
    measurement itself (interval, candle count, error bar) and the non-metric
    facts (stop evidence, cohort labels) are columns.
    """

    __tablename__ = "trade_forensics"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    binance_trade_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("binance_trades.id"), nullable=False, unique=True
    )
    forensics_version: Mapped[str] = mapped_column(String(20), default="1.0.0", nullable=False)
    kline_interval: Mapped[str | None] = mapped_column(String(10))
    kline_candles_in_window: Mapped[int | None] = mapped_column(Integer)
    boundary_inflation_bound_pct: Mapped[float | None] = mapped_column(Float)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, nullable=False, default=dict)
    stop_evidence: Mapped[str] = mapped_column(String(20), default="absent", nullable=False)
    discipline_breach: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    partial_close_suspected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    reentry_same_direction: Mapped[bool | None] = mapped_column(Boolean)
    reentry_after_loss: Mapped[bool | None] = mapped_column(Boolean)
    sizing_mode: Mapped[str | None] = mapped_column(String(20))
    sizing_n: Mapped[int | None] = mapped_column(Integer)
    sizing_excluded: Mapped[int | None] = mapped_column(Integer)
    sizing_partial_close_rows: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
