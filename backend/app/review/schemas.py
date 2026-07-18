from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.bybit.schemas import BybitTradeResponse


class TradeReviewCreate(BaseModel):
    review_mode: str = Field(default="normal", max_length=20)
    severity_score: int = Field(default=0)
    severity_tier: str = Field(default="MILD", max_length=20)
    grade: str | None = Field(default=None, max_length=5)
    one_liner: str | None = None
    full_review: dict[str, Any]
    model_used: str | None = Field(default=None, max_length=100)


class TradeReviewResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    bybit_trade_id: str
    user_id: str
    review_mode: str
    severity_score: int
    severity_tier: str
    grade: str | None = None
    one_liner: str | None = None
    full_review: dict[str, Any]
    model_used: str | None = None
    version: int
    generated_at: datetime
    created_at: datetime


class TradeReviewEnvelope(BaseModel):
    data: TradeReviewResponse
    meta: None = None
    error: None = None


class RRMetrics(BaseModel):
    mode: str  # "r_multiple" | "payoff_ratio"
    sample_size: int
    coverage: float
    label: str
    avg_r_multiple: float | None = None
    payoff_ratio: float | None = None
    expectancy_pct: float | None = None


class HourRange(BaseModel):
    start_hour_utc: int
    end_hour_utc: int
    win_rate: float
    sample_size: int


class SessionStats(BaseModel):
    n: int
    win_rate: float
    total_pnl: float


class SessionSplit(BaseModel):
    asia: SessionStats
    london: SessionStats
    new_york: SessionStats


class StyleBucket(BaseModel):
    n: int
    win_rate: float
    total_pnl: float
    expectancy: float


class StyleBuckets(BaseModel):
    scalp: StyleBucket
    intraday: StyleBucket
    swing: StyleBucket


class StyleSuitability(BaseModel):
    buckets: StyleBuckets
    recommended: str | None = None
    confidence: str
    data_quality: str


class AnalyticsData(BaseModel):
    total_trades: int
    rr: RRMetrics
    best_trade: BybitTradeResponse | None = None
    worst_trade: BybitTradeResponse | None = None
    time_range: HourRange | None = None
    worst_time_range: HourRange | None = None
    sessions: SessionSplit
    style: StyleSuitability
    stop_evidence_coverage: float


class AnalyticsResponse(BaseModel):
    data: AnalyticsData
    meta: None = None
    error: None = None
