from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class BybitApiKeyCreate(BaseModel):
    api_key: str = Field(min_length=1, max_length=255)
    api_secret: str = Field(min_length=1)


class BybitApiKeyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    api_key: str  # masked: "****" + last 4 chars
    status: str
    last_sync_at: datetime | None = None
    created_at: datetime
    updated_at: datetime | None = None


class BybitApiKeyEnvelope(BaseModel):
    data: BybitApiKeyResponse
    meta: None = None
    error: None = None


class BybitTradeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    symbol: str
    side: str
    leverage: float
    entry_price: float
    exit_price: float
    quantity: float
    realized_pnl: float
    roi_percent: float | None = None
    fees: float
    opened_at: datetime
    open_time_source: str
    closed_at: datetime
    stop_loss: float | None = None
    take_profit: float | None = None
    close_trigger: str | None = None
    sl_slippage: float | None = None
    tp_slippage: float | None = None
    created_at: datetime
    updated_at: datetime | None = None


class BybitTradeListEnvelope(BaseModel):
    data: list[BybitTradeResponse]
    meta: dict[str, Any]
    error: None = None


class BybitSyncLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    status: str
    started_at: datetime
    completed_at: datetime | None = None
    trades_imported: int
    error: str | None = None
    created_at: datetime


class BybitSyncLogEnvelope(BaseModel):
    data: BybitSyncLogResponse
    meta: None = None
    error: None = None
