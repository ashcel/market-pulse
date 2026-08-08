from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, model_validator


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
    """One persisted `signal_events` row from the hourly worker pass.

    `state`/`score` are convenience top-level mirrors of
    `features["state"]`/`features["score"]` — the screening card's primary
    sort/display fields — populated from `features` when not supplied
    directly, so callers don't have to drill into the untyped payload for the
    two fields every row is guaranteed to carry.
    """

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
    state: str | None = None
    score: float | None = None

    @model_validator(mode="after")
    def _fill_convenience_fields(self) -> "ReaccumulationEventResponse":
        if self.state is None:
            self.state = self.features.get("state")
        if self.score is None:
            score = self.features.get("score")
            self.score = float(score) if isinstance(score, int | float) else None
        return self


class ReaccumulationListEnvelope(BaseModel):
    data: list[ReaccumulationEventResponse]
    meta: dict[str, Any]
    error: None = None
