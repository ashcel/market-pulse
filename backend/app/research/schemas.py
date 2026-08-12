"""Wire shapes for the forward-test research API.

Shaped for a research table, not a card: flat rows with every column the
question needs, plus one aggregate block. Nothing here is a recommendation and
nothing is a position — these are recorded hypotheses and what happened to
them.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ForwardTestSetupResponse(BaseModel):
    id: str
    symbol: str
    market: str
    mode: str
    direction: str
    # PENDING_ENTRY | ACTIVE | TARGET_HIT | INVALIDATED | EXPIRED | NO_FILL.
    status: str
    detected_at: float

    # The hypothesis, exactly as frozen at detection.
    state: str
    tier: str
    combo: str = ""
    score: float
    entry_low: float
    entry_high: float
    reference_entry: float
    initial_invalidation: float
    target: float
    target_kind: str = ""
    potential_rr: float
    htf_bias: str
    alignment: str
    alignment_level: str
    evidence: dict[str, Any] = Field(default_factory=dict)

    # The lifecycle. `active_stop` may differ from `initial_invalidation`; the
    # latter never changes.
    active_stop: float
    trailing_mode: str
    trailing_activated_at: float | None = None
    trailing_updates: list[list[float]] = Field(default_factory=list)
    zone_touched_at: float | None = None
    entered_at: float | None = None
    entry_price: float | None = None

    # The outcome.
    settled_at: float | None = None
    exit_price: float | None = None
    exit_reason: str = ""
    realized_r: float = 0.0
    # Before costs, and the round trip's bite out of R.
    gross_r: float = 0.0
    cost_r: float = 0.0
    # What alternative exit rules would have produced on this same setup.
    variants: dict[str, Any] = Field(default_factory=dict)
    mfe_pct: float = 0.0
    mae_pct: float = 0.0
    mfe_r: float = 0.0
    mae_r: float = 0.0
    pending_mfe_pct: float = 0.0
    touched_zone: bool = False
    # Seconds from detection to entry, and from entry to settlement.
    time_to_entry: float | None = None
    time_in_trade: float | None = None
    last_price: float = 0.0
    updated_at: float = 0.0

    # Provenance — which exact detector configuration produced this row.
    strategy_version: str
    engine_version: str
    config_hash: str
    git_sha: str
    versions: dict[str, Any] = Field(default_factory=dict)


class ForwardTestStatsResponse(BaseModel):
    """Population statistics.

    Note the denominators: `fill_rate` is over every decided setup,
    `win_rate` is over filled ones only, and `expectancy` is per recorded
    setup — a setup that never filled still used up the opportunity.
    """

    total: int
    open: int
    filled: int
    no_fill: int
    target_hit: int
    invalidated: int
    expired: int
    fill_rate: float
    win_rate: float
    no_fill_rate: float
    average_r: float
    median_r: float
    expectancy: float
    profit_factor: float
    max_drawdown_r: float
    total_r: float
    average_mfe_r: float
    average_mae_r: float


class ForwardTestSummaryResponse(BaseModel):
    """The headline cards: how long this has been running, how much it has
    seen, and how it is doing."""

    days_running: float
    first_detected_at: float | None = None
    setups_recorded: int
    open_now: int
    # The scanner's own funnel, for context on how selective capture is.
    scanned_universe: int
    strategy_version: str
    config_hash: str
    git_sha: str
    best_setup: ForwardTestSetupResponse | None = None


class ForwardTestEventResponse(BaseModel):
    type: str
    ts: float
    price: float
    detail: dict[str, Any] = Field(default_factory=dict)


class ForwardTestData(BaseModel):
    mode: str | None = None
    summary: ForwardTestSummaryResponse
    stats: ForwardTestStatsResponse
    setups: list[ForwardTestSetupResponse] = Field(default_factory=list)


class ForwardTestEnvelope(BaseModel):
    data: ForwardTestData
    meta: None = None
    error: None = None


class ForwardTestDetailData(BaseModel):
    setup: ForwardTestSetupResponse
    events: list[ForwardTestEventResponse] = Field(default_factory=list)


class ForwardTestDetailEnvelope(BaseModel):
    data: ForwardTestDetailData
    meta: None = None
    error: None = None
