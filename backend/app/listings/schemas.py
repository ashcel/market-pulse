"""Response models for the listings API.

The list payload is deliberately narrower than the detail payload: the
screener list renders ~60 rows on a phone, so the bubble map, the post feed
and the full evidence block only ship on the detail route.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ScoreComponent(BaseModel):
    key: str
    score: float
    weight: float
    evidence: str


class ListingSummary(BaseModel):
    """One row of the screener list."""

    symbol: str
    name: str
    chain: str | None = None
    icon_url: str | None = None
    status: str
    # Signed hours until listing; negative once trading. None when unscheduled.
    hours_to_listing: float | None = None
    listing_at: datetime | None = None
    listing_venue: str | None = None

    score: float | None = None
    grade: str | None = None
    coverage: float | None = None
    rejected_because: str | None = None

    current_price: float | None = None
    launch_price: float | None = None
    launch_price_source: str | None = None
    pct_change_since_launch: float | None = None
    percent_change_24h: float | None = None

    market_cap: float | None = None
    fdv: float | None = None
    liquidity: float | None = None
    volume_24h: float | None = None
    holders: int | None = None

    airdrop_live: bool = False
    tge_live: bool = False
    hot_tag: bool = False
    seed_tag: bool = False
    on_alpha: bool = False
    on_spot: bool = False
    on_futures: bool = False

    # Highest-value line from the score, so the list can say *why* without
    # shipping the whole evidence block.
    headline: str | None = None
    warning_count: int = 0
    social_sentiment: float | None = None
    top10_pct: float | None = None
    last_seen_at: datetime | None = None


class HolderBubble(BaseModel):
    address: str
    label: str
    kind: str
    pct: float
    x: float
    y: float
    r: float
    counted: bool


class HolderMapResponse(BaseModel):
    top10_pct: float | None = None
    top50_pct: float | None = None
    largest_holder_pct: float | None = None
    hhi: float | None = None
    holders_counted: int = 0
    pool_pct: float = 0.0
    burn_pct: float = 0.0
    unavailable_reason: str | None = None
    version: str | None = None
    bubbles: list[HolderBubble] = Field(default_factory=list)


class SocialPost(BaseModel):
    id: str
    source: str
    author: str
    text: str
    url: str
    created_at: str
    likes: int = 0
    reposts: int = 0
    replies: int = 0
    followers: int = 0
    sentiment: float = 0.0
    age_hours: float = 0.0


class SocialPulseResponse(BaseModel):
    sentiment: float | None = None
    posts_total: int = 0
    posts_24h: int = 0
    posts_1h: int = 0
    velocity: float | None = None
    spam_ratio: float = 0.0
    reach: int = 0
    bullish_share: float | None = None
    bearish_share: float | None = None
    sources: dict[str, int] = Field(default_factory=dict)
    unavailable_reason: str | None = None
    version: str | None = None
    top_posts: list[SocialPost] = Field(default_factory=list)


class PricePoint(BaseModel):
    observed_at: datetime
    price: float
    pct_change_since_launch: float | None = None
    market_cap: float | None = None
    volume_24h: float | None = None
    liquidity: float | None = None
    score: float | None = None


class ListingDetail(ListingSummary):
    """Everything known about one listing."""

    contract_address: str | None = None
    coingecko_id: str | None = None
    announcement_title: str | None = None
    announcement_url: str | None = None
    announced_at: datetime | None = None
    spot_pair: str | None = None
    futures_pair: str | None = None
    alpha_listed_at: datetime | None = None
    spot_listed_at: datetime | None = None
    futures_listed_at: datetime | None = None

    circulating_supply: float | None = None
    total_supply: float | None = None
    trade_count_24h: int | None = None
    alpha_score: int | None = None
    mul_point: int | None = None
    max_price_since_launch: float | None = None
    min_price_since_launch: float | None = None

    components: list[ScoreComponent] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    score_version: str | None = None
    scored_at: datetime | None = None

    holder_map: HolderMapResponse | None = None
    holder_map_at: datetime | None = None
    social: SocialPulseResponse | None = None
    social_pulse_at: datetime | None = None
    price_series: list[PricePoint] = Field(default_factory=list)
    first_seen_at: datetime | None = None
    inactive: bool = False


class ListingListEnvelope(BaseModel):
    data: list[ListingSummary]
    meta: dict[str, Any] | None = None
    error: None = None


class ListingDetailEnvelope(BaseModel):
    data: ListingDetail | None
    meta: dict[str, Any] | None = None
    error: None = None


class AlertResponse(BaseModel):
    symbol: str
    kind: str
    message: str
    delivered: bool
    delivery_error: str | None = None
    created_at: datetime


class AlertListEnvelope(BaseModel):
    data: list[AlertResponse]
    meta: dict[str, Any] | None = None
    error: None = None


SortKey = Literal["time", "score", "change"]
