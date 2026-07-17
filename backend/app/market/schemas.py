from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class TokenResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    symbol: str
    name: str
    current_price: float | None = None
    market_cap: float | None = None
    volume_24h: float | None = None
    change_24h: float | None = None
    updated_at: datetime | None = None


class SignalResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    token_id: str
    direction: str
    confidence: float | None = None
    entry_price: float | None = None
    target_price: float | None = None
    stop_loss: float | None = None
    reasoning: str | None = None
    strategy: str | None = None
    timeframe: str
    status: str
    created_at: datetime
    triggered_at: datetime | None = None
    resolved_at: datetime | None = None


class TokenListEnvelope(BaseModel):
    data: list[TokenResponse]
    meta: dict[str, Any]
    error: None = None


class TokenDetailEnvelope(BaseModel):
    data: TokenResponse
    meta: None = None
    error: None = None


class SignalListEnvelope(BaseModel):
    data: list[SignalResponse]
    meta: dict[str, Any]
    error: None = None


class SignalDetailEnvelope(BaseModel):
    data: SignalResponse
    meta: None = None
    error: None = None
