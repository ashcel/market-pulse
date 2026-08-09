from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class RallyWatcherEvaluateRequest(BaseModel):
    symbol: str = Field(max_length=20)


class RallyReadResponse(BaseModel):
    """Mirror of `smc.rally_watcher.RallyRead`, computed live. `targets`/
    `liquidity` carry the raw target dicts (price/distance_pct/label/detail)
    straight through — see `smc.rally_watcher` for the shapes and the
    liquidation-estimate formulas."""

    symbol: str
    direction: str
    gain_pct: float
    volume_mult: float
    momentum_score: float
    extended: bool
    targets: dict[str, dict[str, Any]]
    liquidity: dict[str, list[dict[str, Any]]]
    explanation: str
    evaluated_at: int
    oi_available: bool
    verdict: str
    verdict_reason: str
    version: str


class RallyWatcherEvaluateEnvelope(BaseModel):
    data: RallyReadResponse | None
    meta: None = None
    error: None = None


class RallyWatcherScanData(BaseModel):
    updated_at: datetime
    universe_size: int
    rallies: list[RallyReadResponse]
    # True while the all-market background scan is still running (or the
    # cache is empty, cold start) — the client shows a "scanning" state
    # instead of treating an empty list as "no rallies right now".
    scanning: bool = False


class RallyWatcherScanEnvelope(BaseModel):
    data: RallyWatcherScanData
    meta: None = None
    error: None = None
