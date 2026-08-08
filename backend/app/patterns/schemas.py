from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ReaccumulationEvaluateRequest(BaseModel):
    symbol: str = Field(max_length=20)


class ReaccumulationReadResponse(BaseModel):
    """Mirror of `smc.reaccumulation.ReaccumulationRead`, computed live."""

    pattern: str
    state: str
    score: float
    direction: str
    evidence: dict[str, dict[str, Any]]
    explanation: str
    evaluated_at: int
    oi_available: bool
    version: str
    impulse_start_time: int
    impulse_end_time: int
    impulse_magnitude_pct: float
    retracement_time: int
    retracement_fraction: float
    base_start_time: int
    base_end_time: int
    base_high: float
    base_low: float
    breakout_pct: float


class ReaccumulationEvaluateEnvelope(BaseModel):
    data: ReaccumulationReadResponse | None
    meta: None = None
    error: None = None


class ReaccumulationEventResponse(BaseModel):
    """One persisted `signal_events` row from the hourly worker pass."""

    id: str
    symbol: str
    side: str
    horizon: str
    conviction: str | None
    detected_at: datetime
    expires_at: datetime | None
    source_version: str
    status: str
    features: dict[str, Any]


class ReaccumulationListEnvelope(BaseModel):
    data: list[ReaccumulationEventResponse]
    meta: dict[str, Any]
    error: None = None
