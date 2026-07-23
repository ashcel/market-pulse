"""Response shapes for the events read model.

Every row serves the stored columns verbatim (nothing renamed or removed vs.
the legacy TS read models' underlying tables) **plus** the additive
serve-time Catalyst Impact Score fields: `impact`, `direction`,
`impact_version`, `impact_score`, `impact_capped`, `impact_components`, and
`impact_disclaimer`.

One naming note: `economic_event` already stores a feed-supplied `impact`
tier (high | medium | low | holiday). On this surface that stored tier is
served as `source_impact` so the computed fields keep the same names across
all three event planes; the legacy TS route (`/api/economic-events`) is
untouched and still serves the feed tier as `impact`.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel

from .impact import ImpactResult


class ImpactComponentResponse(BaseModel):
    factor: str
    weight: float
    fraction: float
    points: float
    detail: str


class _ImpactFields(BaseModel):
    """The additive Catalyst Impact Score block shared by every event row."""

    impact: str
    direction: str
    impact_version: str
    impact_score: float
    impact_capped: bool
    impact_components: list[ImpactComponentResponse]
    impact_disclaimer: str


def impact_fields(result: ImpactResult) -> dict[str, Any]:
    """Flatten a pure `ImpactResult` into the shared response fields."""
    return {
        "impact": result.impact.value,
        "direction": result.direction.value,
        "impact_version": result.version,
        "impact_score": result.score,
        "impact_capped": result.capped,
        "impact_components": [
            ImpactComponentResponse(
                factor=c.factor.value,
                weight=c.weight,
                fraction=c.fraction,
                points=c.points,
                detail=c.detail,
            )
            for c in result.components
        ],
        "impact_disclaimer": result.disclaimer,
    }


class TokenEventResponse(_ImpactFields):
    id: str
    symbol: str
    kind: str
    severity: str
    title: str
    body: str | None = None
    source: str
    url: str | None = None
    published_at: datetime
    created_at: datetime


class CatalystEventResponse(_ImpactFields):
    id: str
    symbol: str
    kind: str
    title: str
    description: str | None = None
    occurs_at: datetime
    source: str
    source_id: str | None = None
    url: str | None = None
    credibility: dict[str, Any] | None = None
    percent_of_supply: float | None = None
    created_at: datetime
    updated_at: datetime


class EconomicEventResponse(_ImpactFields):
    id: str
    title: str
    country: str
    source_impact: str
    """The feed's own tier (high | medium | low | holiday), verbatim — the
    computed banding is in `impact`."""
    forecast: str | None = None
    previous: str | None = None
    occurs_at: datetime
    source: str
    created_at: datetime
    updated_at: datetime


class TokenEventListEnvelope(BaseModel):
    data: list[TokenEventResponse]
    meta: dict[str, Any]
    error: None = None


class CatalystEventListEnvelope(BaseModel):
    data: list[CatalystEventResponse]
    meta: dict[str, Any]
    error: None = None


class EconomicEventListEnvelope(BaseModel):
    data: list[EconomicEventResponse]
    meta: dict[str, Any]
    error: None = None
