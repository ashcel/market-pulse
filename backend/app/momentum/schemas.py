"""Wire shapes for the MOMENTUM RADAR API.

Card-shaped by design: the Discover UI renders compact cards that must be
readable in one to two seconds, so the payload leads with the durable event
(what happened, how big, how long ago) and carries the realtime flow behind it
as *secondary* telemetry.

The split mirrors the engine layers exactly:

* `EventResponse` / `headline` — durable, hysteretic, safe to put in bold.
* `TelemetryResponse` — the raw reactive reads (pressure phrases, trade rate).
  Useful, but too unstable to headline; deliberately nested so it cannot creep
  back onto the primary line.
* `timeline` — the sequence of events, so "what happened here" is answerable
  rather than only "what is the instantaneous state".

Long-form narrative, targets and SMC context stay on the token page.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class EventResponse(BaseModel):
    """One durable market event."""

    type: str
    direction: str | None = None
    # Mint time — what "detected Ns ago" counts from. Never advances.
    ts: float
    # Last tick the underlying condition still held.
    last_seen_ts: float
    # Current reading (signed for price moves) and the most extreme one seen.
    magnitude: float
    peak_magnitude: float
    # "x" (a multiple of baseline), "%" or "price".
    unit: str
    score: float
    # Short untranslated token, e.g. "HH"/"LL" on a structure break.
    qualifier: str = ""
    # Whether the condition behind it still holds. An inactive event is still
    # shown — it just no longer describes the current tick.
    active: bool
    age_seconds: float


class TelemetryResponse(BaseModel):
    """Realtime flow. Secondary by construction — never a card headline.

    `pressure` in particular ("heavy sell pressure", "buyers stepping in") is
    the most reactive string the radar produces; it lives here so it can be
    read as telemetry without being mistaken for an insight.
    """

    pressure: str = ""
    change_1m_pct: float | None = None
    change_3m_pct: float | None = None
    change_5m_pct: float | None = None
    # Context only — never the primary trigger.
    change_15m_pct: float | None = None
    change_24h_pct: float = 0.0

    rvol_1m: float | None = None
    rvol_3m: float | None = None
    rvol_5m: float | None = None
    trade_rate_mult: float | None = None
    range_expansion: float | None = None

    # Approximate: derived from 24h rolling counter differences, see
    # `app.momentum.state`. Shown as a magnitude, never summed or persisted.
    quote_volume_1m: float = 0.0
    quote_volume_24h: float = 0.0
    trades_1m: float = 0.0


class TimeframeReadResponse(BaseModel):
    """One higher-timeframe structural read from the slow lane."""

    timeframe: str
    bias: str
    trend: str
    # Latest structural break on that timeframe: "bos" | "choch" | null.
    event: str | None = None
    event_label: str | None = None
    change_pct: float
    bars: int
    computed_at: float


class ContextResponse(BaseModel):
    """Cached 4H/1H/15m/5m context — the "where are we" half of the card.

    Updates on the slow lane's own timers (minutes), never on a realtime tick,
    and its `bias` only flips after confirmation, so the badge is safe to read
    at a glance.
    """

    bias: str
    agreement: float
    score: float
    reads: list[TimeframeReadResponse] = Field(default_factory=list)
    updated_at: float
    # When the displayed bias last actually changed.
    bias_since: float


class AlignmentResponse(BaseModel):
    """How the fast event sits against the slow context.

    Descriptive only. "counter_trend" is not a reversal call and "aligned" is
    not an entry — Discover is an observation layer.
    """

    level: str
    classification: str
    agreement: float
    context_bias: str
    event_direction: str | None = None


class LevelResponse(BaseModel):
    """A price the market has already reacted to."""

    price: float
    kind: str
    timeframe: str
    touches: int = 1


class PullbackResponse(BaseModel):
    """Measurements of the current retracement — no verdicts."""

    state: str
    retrace_frac: float
    retrace_pct: float
    duration_seconds: float
    volume_ratio: float | None = None
    opposing_move_pct: float
    structure_intact: bool
    is_healthy: bool
    at_level: LevelResponse | None = None


class EvidenceResponse(BaseModel):
    """One completion observation and the reading behind it."""

    code: str
    met: bool
    detail: str


class CompletionResponse(BaseModel):
    """Evidence that the pullback may be ending.

    Deliberately a list rather than a score: the card shows which items fired,
    and `has_trigger` records whether any of them was an actual event rather
    than the tape merely going quiet.
    """

    state: str
    met_count: int
    has_trigger: bool
    evidence: list[EvidenceResponse] = Field(default_factory=list)


class TargetResponse(BaseModel):
    level: LevelResponse
    distance_pct: float


class PathResponse(BaseModel):
    """The structural path that *would* be in play. Never an order.

    `rr` is a filter — a short path is rejected upstream — not a claim that the
    move will happen.
    """

    entry: float
    invalidation: float
    target: float
    target_kind: str = ""
    risk_pct: float
    reward_pct: float
    rr: float
    verdict: str


class StructuralBackingResponse(BaseModel):
    """Slow structural context (reaccumulation), carried for display and for
    the forward-test record. It gates nothing — see `structural_cache`."""

    state: str
    score: float
    side: str
    detected_at: float


class RadarEntryResponse(BaseModel):
    symbol: str
    # NEW | DEVELOPING | PULLBACK | PULLBACK_COMPLETION |
    # CONTINUATION_CANDIDATE | INVALID | STALE.
    state: str
    mode: str
    direction: str | None = None
    # EWMA of the raw event score: drifts rather than jumping.
    score: float

    # The event the card leads with, and every event still live on this symbol.
    headline: EventResponse | None = None
    events: list[EventResponse] = Field(default_factory=list)
    # Most recent first `HISTORY_TAIL` events; the full log is on /timeline.
    timeline: list[EventResponse] = Field(default_factory=list)

    # Evidence quality: NONE | LOW | MEDIUM | HIGH, the named relationship
    # behind it, and which independent families contributed.
    tier: str = "NONE"
    combo: str = ""
    families: list[str] = Field(default_factory=list)
    structural: StructuralBackingResponse | None = None

    telemetry: TelemetryResponse
    context: ContextResponse | None = None
    alignment: AlignmentResponse
    pullback: PullbackResponse | None = None
    completion: CompletionResponse | None = None
    targets: list[TargetResponse] = Field(default_factory=list)
    path: PathResponse | None = None

    # Why this passed (or failed) the funnel — codes, not sentences.
    worth_watching: bool = False
    reasons: list[str] = Field(default_factory=list)

    first_seen: float
    state_since: float
    updated_at: float


class FunnelResponse(BaseModel):
    """How many candidates survived each stage of the last sweep.

    Shipped so an empty radar can be explained: "600 markets, 4 events, none
    structurally relevant" is information, an empty page alone is not.
    """

    universe: int
    tracked: int
    events: int
    # Symbols whose events form a real relationship (not a lone observation).
    qualified: int
    directional: int
    structural: int
    developing: int
    surfaced: int


class RegimeResponse(BaseModel):
    """The whole-market read at this tick (`smc.market_regime`).

    Context for the situations below it, never a filter on them: no card is
    shown, hidden or ranked by this. `unknown` means too few liquid symbols had
    the window yet — the honest answer during a cold start, and not the same
    claim as `choppy`.
    """

    # bullish | bearish | choppy | unknown.
    state: str = "unknown"
    # Advancing minus declining share, -1.0 … +1.0.
    breadth: float = 0.0
    # Median absolute move across voting symbols — separates a dead range from
    # a violent two-sided tape, which share the `choppy` label.
    energy_pct: float = 0.0
    # How many symbols voted, out of how many were seen.
    sample: int = 0
    universe: int = 0
    version: str = ""


class RadarData(BaseModel):
    updated_at: float
    # SCALP | INTRADAY — which profile produced this snapshot.
    mode: str
    # `smc.momentum` flow/detector version.
    version: str
    # `smc.momentum_events` durable-layer version.
    events_version: str
    # `smc.market_context` slow-lane version.
    context_version: str
    # `smc.situation_journal` record-shape version.
    journal_version: str
    universe_size: int
    tracked: int
    connected: bool
    # "ws" | "rest" | "starting" — the transport feeding the in-memory store.
    feed: str
    warming_up: bool
    regime: RegimeResponse = Field(default_factory=RegimeResponse)
    funnel: FunnelResponse
    # The surfaced situations, ranked. Often short, sometimes empty — that is
    # the design, not a failure.
    situations: list[RadarEntryResponse] = Field(default_factory=list)
    closed: list[RadarEntryResponse] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=dict)


class RadarEnvelope(BaseModel):
    data: RadarData
    meta: None = None
    error: None = None


class TimelineData(BaseModel):
    """One symbol's full event sequence, under its higher-timeframe context.

    The two together are the answer to "where are we / what just happened / is
    it developing" — a sequence with no context, or context with no sequence,
    only answers half of it.
    """

    symbol: str
    state: str | None = None
    direction: str | None = None
    score: float = 0.0
    first_event_at: float | None = None
    updated_at: float | None = None
    context: ContextResponse | None = None
    alignment: AlignmentResponse | None = None
    events: list[EventResponse] = Field(default_factory=list)


class TimelineEnvelope(BaseModel):
    data: TimelineData
    meta: None = None
    error: None = None


class JournalEntryResponse(BaseModel):
    """One recorded situation, for later measurement of the process itself.

    Not a trade: `entry` / `invalidation` / `target` are the structural path
    that was on the table, and nothing was ever sent anywhere.
    """

    key: str
    symbol: str
    mode: str
    direction: str
    opened_at: float
    trigger_type: str
    trigger_ts: float
    context_bias: str
    alignment: str
    alignment_level: str
    pullback_started_at: float | None = None
    completion_at: float | None = None
    completion_evidence: list[str] = Field(default_factory=list)
    entry: float | None = None
    invalidation: float | None = None
    target: float | None = None
    target_kind: str = ""
    rr: float | None = None
    mfe_pct: float = 0.0
    mae_pct: float = 0.0
    reached_completion: bool = False
    reached_continuation: bool = False
    outcome: str = "OPEN"
    closed_at: float | None = None
    updated_at: float = 0.0


class JournalData(BaseModel):
    mode: str
    version: str
    stats: dict[str, float] = Field(default_factory=dict)
    entries: list[JournalEntryResponse] = Field(default_factory=list)


class JournalEnvelope(BaseModel):
    data: JournalData
    meta: None = None
    error: None = None
