import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class BybitApiKey(Base):
    __tablename__ = "bybit_api_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True, index=True)
    api_key: Mapped[str] = mapped_column(String(255), nullable=False)
    encrypted_secret: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="inactive", nullable=False)
    last_sync_at: Mapped[datetime | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
    updated_at: Mapped[datetime | None] = mapped_column(
        default=None, onupdate=lambda: datetime.now(), nullable=True
    )


class BybitTrade(Base):
    __tablename__ = "bybit_trades"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "exchange_trade_id",
            name="bybit_trades_user_id_exchange_trade_id_key",
        ),
        sa.Index("bybit_trades_user_id_closed_at_idx", "user_id", "closed_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    exchange_trade_id: Mapped[str] = mapped_column(String(100), nullable=False)
    symbol: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    side: Mapped[str] = mapped_column(String(10), nullable=False)  # "LONG" | "SHORT"
    leverage: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    entry_price: Mapped[float] = mapped_column(Float, nullable=False)
    exit_price: Mapped[float] = mapped_column(Float, nullable=False)
    quantity: Mapped[float] = mapped_column(Float, nullable=False)
    realized_pnl: Mapped[float] = mapped_column(Float, nullable=False)
    roi_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    fees: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    opened_at: Mapped[datetime] = mapped_column(nullable=False)
    open_time_source: Mapped[str] = mapped_column(String(20), default="estimated", nullable=False)
    closed_at: Mapped[datetime] = mapped_column(nullable=False)
    stop_loss: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit: Mapped[float | None] = mapped_column(Float, nullable=True)
    close_trigger: Mapped[str | None] = mapped_column(String(20), nullable=True)
    sl_slippage: Mapped[float | None] = mapped_column(Float, nullable=True)
    tp_slippage: Mapped[float | None] = mapped_column(Float, nullable=True)
    raw_close_pnl: Mapped[dict[str, Any] | None] = mapped_column(sa.JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
    updated_at: Mapped[datetime | None] = mapped_column(
        default=None, onupdate=lambda: datetime.now(), nullable=True
    )


class BybitSyncLog(Base):
    __tablename__ = "bybit_sync_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # syncing|success|failed
    started_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    trades_imported: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
