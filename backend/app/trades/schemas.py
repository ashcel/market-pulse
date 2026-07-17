from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TradeCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    direction: str = Field(pattern=r"^(long|short)$")
    entry_price: float = Field(gt=0)
    quantity: float = Field(gt=0)
    leverage: int = Field(default=1, ge=1, le=125)
    strategy: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=2000)
    opened_at: datetime | None = None


class TradeUpdate(BaseModel):
    exit_price: float | None = Field(default=None, gt=0)
    pnl: float | None = None
    pnl_percent: float | None = None
    status: str | None = Field(default=None, pattern=r"^(open|closed|cancelled)$")
    notes: str | None = Field(default=None, max_length=2000)
    closed_at: datetime | None = None


class TradeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    symbol: str
    direction: str
    entry_price: float
    exit_price: float | None = None
    quantity: float
    leverage: int
    pnl: float | None = None
    pnl_percent: float | None = None
    status: str
    strategy: str | None = None
    notes: str | None = None
    opened_at: datetime | None = None
    closed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime | None = None


class TradeDetailEnvelope(BaseModel):
    data: TradeResponse
    meta: None = None
    error: None = None


class TradeListEnvelope(BaseModel):
    data: list[TradeResponse]
    meta: dict[str, Any]
    error: None = None
