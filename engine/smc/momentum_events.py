"""MOMENTUM RADAR — durable market-event layer.

`momentum.py` reads the tape: it scores flow and walks a symbol through
MOMENTUM/PULLBACK/CONTINUATION on every tick. That layer is *correct* but far
too reactive to put on screen directly — relative volume halves between two
ticks and a card that renders raw flow renames itself twice a second.

This module is the stabilizer. It sits between realtime flow and the UI and
enforces one rule:

    realtime flow underneath, durable events on top.

## Three concepts, deliberately separated

**Flow** (`WindowMetrics`) changes every tick. It is an *input* here, never a
headline. It is still shipped to the card, but as secondary telemetry.

**Events** (`MarketEvent`) are what flow *did*. An event is minted once, when a
condition crosses its fire threshold, and then keeps its identity and its
`ts` — "detected 18s ago" counts from the mint, not from the last tick that
happened to agree. It survives the condition normalizing: it stays *active*
while the condition holds above a lower **clear** threshold (hysteresis), then
lingers, inactive, until `event_ttl_seconds`. A volume anomaly that spiked to
5.7x and fell back to 1.1x is still a volume anomaly that happened; the card
keeps saying so.

**Tracker state** (`SymbolTracker.state`) is the durable read the UI groups by:

    NEW ──► DEVELOPING ──► CONFIRMED
     └───────────┴──────────────┴────► FADED

Promotion is **monotone** — a tracker never walks back to a weaker state. That
single property is what stops the section flip-flopping that plagued the raw
state machine: the only way out of a section is forward, or expiry. Every
promotion additionally needs `min_state_seconds` of dwell, so two adjacent
ticks can never produce two transitions.

`FADED` is terminal and is reached only on invalidation (the impulse base lost,
or a hard counter-move). It is not a demotion of DEVELOPING/CONFIRMED so much
as the end of the story, and it is displayed in its own collapsed section.

## Where the structural events come from

`STRUCTURE_BREAK`, `PULLBACK`, `CONTINUATION` and `INVALIDATION` are derived
from the existing (tested) state machine in `momentum.py` via
`structural_events`, rather than being re-detected here. The machine's
transitions stop being the UI's primary categorization and become event
sources — which is exactly what they are good at, since each one is a discrete
occurrence rather than a continuously wobbling read.

## Purity contract

Same as `momentum.py`: no I/O, no clock reads, no globals, nothing mutated.
`advance_tracker(tracker, metrics, now, config)` is a pure function of its
arguments, so the whole radar is replayable from a recorded tape and every
state on screen can be explained after the fact from `SymbolTracker.timeline`.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Literal

from smc.context_alignment import UNKNOWN as UNKNOWN_ALIGNMENT
from smc.context_alignment import Alignment, classify
from smc.market_context import DEFAULT_CONTEXT_CONFIG, ContextConfig, MarketContext
from smc.momentum import Candidate, Direction, WindowMetrics, signed_change

# Provenance stamp for the event layer specifically. Bumping this does not
# touch ENGINE_VERSION: the radar is a discovery plane, not the trading engine.
MOMENTUM_EVENTS_VERSION = "1.1.0"

EventType = Literal[
    "VOLUME_ANOMALY",
    "PRICE_DISPLACEMENT",
    "VOLATILITY_EXPANSION",
    "TRADE_RATE_EXPANSION",
    "CHOCH",
    "STRUCTURE_BREAK",
    "PULLBACK",
    "CONTINUATION",
    "VOLUME_COOLING",
    "INVALIDATION",
]

TrackerState = Literal["NEW", "DEVELOPING", "CONFIRMED", "FADED"]

#: Events that count as *structural consequence* — the gate into CONFIRMED. A
#: 1m CHoCH qualifies: it is the fast lane's own structural read, not a volume
#: reading dressed up as one.
STRUCTURAL_TYPES: frozenset[str] = frozenset({"STRUCTURE_BREAK", "CONTINUATION", "CHOCH"})

#: Which event earns the card headline when several are live. Ordered by "how
#: much does this explain what is happening", not by severity.
EVENT_PRIORITY: dict[str, int] = {
    "INVALIDATION": 8,
    "CONTINUATION": 7,
    "CHOCH": 6,
    "STRUCTURE_BREAK": 5,
    "VOLUME_ANOMALY": 4,
    "PRICE_DISPLACEMENT": 3,
    "VOLATILITY_EXPANSION": 2,
    "TRADE_RATE_EXPANSION": 1,
    "PULLBACK": 1,
    "VOLUME_COOLING": 0,
}

#: Which *kind* of information an event carries. Two events from the same
#: family corroborate almost nothing — a volume anomaly and a trade-rate
#: expansion are two views of the same crowd — so qualification and scoring
#: both count families, never event types.
EVENT_FAMILY: dict[str, str] = {
    "PRICE_DISPLACEMENT": "PRICE",
    "VOLUME_ANOMALY": "PARTICIPATION",
    "TRADE_RATE_EXPANSION": "PARTICIPATION",
    "VOLATILITY_EXPANSION": "VOLATILITY",
    "CHOCH": "STRUCTURE",
    "STRUCTURE_BREAK": "STRUCTURE",
    "CONTINUATION": "STRUCTURE",
    # Deliberately family-less: these describe an *existing* situation rather
    # than evidence that one is starting, so they never qualify or score.
    "PULLBACK": "",
    "VOLUME_COOLING": "",
    "INVALIDATION": "",
}

QualityTier = Literal["NONE", "LOW", "MEDIUM", "HIGH"]

_EPS = 1e-9


# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class EventConfig:
    """Every threshold the event/state layer uses, in one place.

    Fire/clear pairs are the hysteresis: a condition must exceed `*_fire_*` to
    mint an event and then only has to hold above `*_clear_*` to keep it
    active. The gap between the two is the dead band that stops a metric
    oscillating around a single threshold from strobing the UI.
    """

    # ── working windows ─────────────────────────────────────────────────────
    # Which rolling windows every detector below reads. Scalp fires off 1m/3m;
    # intraday shifts out to 5m/15m (`smc.scan_profiles`). One detector, two
    # horizons — rather than two copies of the same logic.
    fast_window: str = "1m"
    primary_window: str = "3m"

    # ── volume anomaly (measured on the steadier primary-window rvol) ────────
    volume_anomaly_fire_rvol: float = 3.0
    volume_anomaly_clear_rvol: float = 1.8
    volume_anomaly_scale_rvol: float = 8.0

    # ── price displacement (3m, signed against the tracker's direction) ──────
    displacement_fire_pct: float = 0.80
    displacement_clear_pct: float = 0.35
    displacement_scale_pct: float = 2.50

    # ── volatility expansion (1m range vs its EWMA baseline) ────────────────
    volatility_fire_mult: float = 2.50
    volatility_clear_mult: float = 1.40
    volatility_scale_mult: float = 5.00

    # ── trade-rate expansion (1m trade count vs baseline rate) ──────────────
    # Participation *breadth*, as distinct from volume: many small prints and
    # a few large ones are different tape, and the detectors stay separate.
    trade_rate_fire_mult: float = 3.00
    trade_rate_clear_mult: float = 1.60
    trade_rate_scale_mult: float = 8.00

    # ── volume cooling (only ever fires after this symbol printed an anomaly)
    cooling_fire_rvol: float = 0.90
    cooling_clear_rvol: float = 1.30

    # ── a hard move against an established direction ends the story ─────────
    invalidation_opposing_pct: float = 0.90

    # ── event durability ────────────────────────────────────────────────────
    # An event is "active" while its condition held within this many seconds…
    event_active_seconds: float = 30.0
    # …and stays visible (inactive, still explaining the card) until this many
    # seconds after the condition last held. This is the whole point of the
    # layer: the event outlives the metric that produced it.
    event_ttl_seconds: float = 180.0
    # A structural event of the same type arriving within this window is
    # treated as the same occurrence rather than a second one.
    structural_dedupe_seconds: float = 20.0

    # ── event scores ────────────────────────────────────────────────────────
    # A condition event scores `event_score_floor` at its fire threshold and
    # 100 at its scale, so the number is comparable across event types.
    event_score_floor: float = 40.0
    structure_break_score: float = 72.0
    choch_score: float = 68.0
    continuation_score: float = 78.0
    pullback_score: float = 45.0
    cooling_score: float = 25.0
    invalidation_score: float = 20.0
    # Scoring is built from *independent* evidence only. One family, however
    # extreme, can never reach the top of the scale: a 6x volume spike with no
    # price response is a 6x volume spike, not a 100/100 situation. The
    # coverage factor runs from `min_family_coverage` (one family) to 1.0 (all
    # four), and the score is the mean of each family's best severity.
    min_family_coverage: float = 0.55
    family_scale: float = 4.0

    # ── state machine ───────────────────────────────────────────────────────
    # No promotion may happen within this long of the last one. With a 2s scan
    # tick that is ~10 ticks of dwell — a section cannot strobe.
    min_state_seconds: float = 20.0
    # A tracker stops being "new" once it is this old, even alone.
    new_window_seconds: float = 90.0
    developing_min_event_types: int = 2
    # Kept after the last event expired, so a symbol does not vanish the
    # instant its tape goes quiet.
    tracker_grace_seconds: float = 120.0
    faded_ttl_seconds: float = 180.0
    timeline_max: int = 40

    # ── display stability ───────────────────────────────────────────────────
    # The card's score is an EWMA of the raw score: it drifts instead of
    # jumping, which also keeps ranking calm.
    display_alpha: float = 0.35
    # Ranking compares score *buckets*, not scores. Two candidates inside the
    # same bucket never swap places on noise — the tiebreak is age, which does
    # not move.
    rank_bucket: float = 5.0

    def __post_init__(self) -> None:
        pairs = (
            ("volume_anomaly", self.volume_anomaly_clear_rvol, self.volume_anomaly_fire_rvol),
            ("displacement", self.displacement_clear_pct, self.displacement_fire_pct),
            ("volatility", self.volatility_clear_mult, self.volatility_fire_mult),
            ("trade_rate", self.trade_rate_clear_mult, self.trade_rate_fire_mult),
        )
        for name, clear, fire in pairs:
            if clear > fire:
                raise ValueError(f"{name}: clear threshold {clear!r} must not exceed fire {fire!r}")
        if self.cooling_clear_rvol < self.cooling_fire_rvol:
            raise ValueError("cooling clear threshold must not be below its fire threshold")
        if self.event_ttl_seconds < self.event_active_seconds:
            raise ValueError("event TTL must be at least the active window")
        if self.rank_bucket <= 0:
            raise ValueError("rank_bucket must be positive")
        if not 0.0 < self.display_alpha <= 1.0:
            raise ValueError("display_alpha must be in (0, 1]")


DEFAULT_EVENT_CONFIG = EventConfig()


# ─────────────────────────────────────────────────────────────────────────────
# Events
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MarketEvent:
    """One durable occurrence on one symbol.

    `ts` is the mint time and never moves — it is what "detected 18s ago"
    counts from. `last_seen_ts` is the last tick the underlying condition still
    held, and is the only field a refresh advances; it drives both activeness
    and expiry. `magnitude` tracks the live reading while the condition holds
    (so a growing anomaly is not frozen at its first value) while
    `peak_magnitude` records the worst/most extreme it ever got.
    """

    symbol: str
    type: EventType
    direction: Direction | None
    ts: float
    last_seen_ts: float
    magnitude: float
    peak_magnitude: float
    unit: str
    # Severity of the *current* reading while the condition holds, frozen at
    # its last held value once it stops. `peak_score` keeps the high-water mark
    # so a card can still say how big this got.
    score: float
    peak_score: float
    # Free-form short token for types that need one ("HH"/"LL" on a structure
    # break). Never translated — the UI maps it.
    qualifier: str = ""

    def is_active(self, now: float, config: EventConfig = DEFAULT_EVENT_CONFIG) -> bool:
        """True while the condition behind this event still holds (or held very
        recently). An inactive event is still *shown* — it just no longer
        describes the current tick."""
        return now - self.last_seen_ts < config.event_active_seconds

    def is_expired(self, now: float, config: EventConfig = DEFAULT_EVENT_CONFIG) -> bool:
        return now - self.last_seen_ts >= config.event_ttl_seconds

    def age(self, now: float) -> float:
        return max(0.0, now - self.ts)


def _clip(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _severity(value: float, fire: float, scale: float, config: EventConfig) -> float:
    """Maps a condition's magnitude onto [floor, 100]: floor at the fire
    threshold, 100 at saturation. Keeps scores comparable across event types."""
    span = scale - fire
    fraction = _clip((value - fire) / span) if span > _EPS else 1.0
    return round(config.event_score_floor + (100.0 - config.event_score_floor) * fraction, 2)


# ─────────────────────────────────────────────────────────────────────────────
# Condition reads (flow → candidate events)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ConditionRead:
    """One tick's verdict on one condition. `fires` mints a new event, `holds`
    keeps an existing one alive — the two thresholds are what make the layer
    hysteretic rather than reactive."""

    type: EventType
    direction: Direction | None
    magnitude: float
    unit: str
    score: float
    fires: bool
    holds: bool


def _rvol(metrics: WindowMetrics, config: EventConfig) -> float | None:
    """The steadier relative-volume read: the primary window first, because the
    fast one swings hard enough to be the main source of the flicker this
    module exists to remove."""
    primary: float | None = getattr(metrics, f"rvol_{config.primary_window}", None)
    if primary is not None:
        return primary
    fast: float | None = getattr(metrics, f"rvol_{config.fast_window}", None)
    return fast


def _window_change(metrics: WindowMetrics, window: str) -> float | None:
    value: float | None = getattr(metrics, f"change_{window}_pct", None)
    return value


def _move_direction(metrics: WindowMetrics, config: EventConfig) -> Direction | None:
    change = _window_change(metrics, config.primary_window)
    if change is None:
        change = _window_change(metrics, config.fast_window)
    if change is None or abs(change) <= _EPS:
        return None
    return "bullish" if change > 0 else "bearish"


def evaluate_conditions(
    metrics: WindowMetrics,
    config: EventConfig = DEFAULT_EVENT_CONFIG,
    *,
    direction: Direction | None = None,
    had_anomaly: bool = False,
    in_pullback: bool = False,
) -> dict[EventType, ConditionRead]:
    """Reads this tick's flow into per-type fire/hold verdicts.

    `direction` is the tracker's established direction, if it has one: price
    displacement is then judged *in that direction*, so a counter-move cannot
    silently re-brand a bullish tracker as bearish.

    Volume is **flow, not state**. "Cooling" only means something after a real
    impulse and while price is actually retracing, so it needs both
    `had_anomaly` and `in_pullback`; on any other tape a quiet minute is just a
    quiet minute and minting an event for it would be pure noise.
    """
    reads: dict[EventType, ConditionRead] = {}

    rvol = _rvol(metrics, config)
    if rvol is not None:
        reads["VOLUME_ANOMALY"] = ConditionRead(
            type="VOLUME_ANOMALY",
            direction=direction or _move_direction(metrics, config),
            magnitude=round(rvol, 2),
            unit="x",
            score=_severity(
                rvol,
                config.volume_anomaly_fire_rvol,
                config.volume_anomaly_scale_rvol,
                config,
            ),
            fires=rvol >= config.volume_anomaly_fire_rvol,
            holds=rvol >= config.volume_anomaly_clear_rvol,
        )
        if had_anomaly and in_pullback:
            # Cooling is the mirror: it fires *below* its threshold and clears
            # above the higher one, so the same dead-band logic applies.
            reads["VOLUME_COOLING"] = ConditionRead(
                type="VOLUME_COOLING",
                direction=None,
                magnitude=round(rvol, 2),
                unit="x",
                score=config.cooling_score,
                fires=rvol <= config.cooling_fire_rvol,
                holds=rvol <= config.cooling_clear_rvol,
            )

    change_primary = _window_change(metrics, config.primary_window)
    if change_primary is not None:
        # Signed against the tracker's own direction when it has one, so
        # bullish and bearish read identically (the symmetry the tests pin).
        signed = (
            change_primary
            if direction is None
            else (signed_change(metrics, direction, config.primary_window) or 0.0)
        )
        move_direction = direction or _move_direction(metrics, config)
        if signed >= 0.0 or direction is None:
            magnitude = abs(signed if direction is not None else change_primary)
            reads["PRICE_DISPLACEMENT"] = ConditionRead(
                type="PRICE_DISPLACEMENT",
                direction=move_direction,
                magnitude=round(change_primary, 2),
                unit="%",
                score=_severity(
                    magnitude, config.displacement_fire_pct, config.displacement_scale_pct, config
                ),
                fires=magnitude >= config.displacement_fire_pct,
                holds=magnitude >= config.displacement_clear_pct,
            )
        elif -signed >= config.invalidation_opposing_pct:
            # A hard counter-move on an established direction: not a
            # displacement event, an ending.
            reads["INVALIDATION"] = ConditionRead(
                type="INVALIDATION",
                direction=direction,
                magnitude=round(change_primary, 2),
                unit="%",
                score=config.invalidation_score,
                fires=True,
                holds=True,
            )

    trade_rate = metrics.trade_rate_mult
    if trade_rate is not None:
        reads["TRADE_RATE_EXPANSION"] = ConditionRead(
            type="TRADE_RATE_EXPANSION",
            direction=None,
            magnitude=round(trade_rate, 2),
            unit="x",
            score=_severity(
                trade_rate, config.trade_rate_fire_mult, config.trade_rate_scale_mult, config
            ),
            fires=trade_rate >= config.trade_rate_fire_mult,
            holds=trade_rate >= config.trade_rate_clear_mult,
        )

    expansion = metrics.range_expansion
    if expansion is not None:
        reads["VOLATILITY_EXPANSION"] = ConditionRead(
            type="VOLATILITY_EXPANSION",
            direction=None,
            magnitude=round(expansion, 2),
            unit="x",
            score=_severity(
                expansion, config.volatility_fire_mult, config.volatility_scale_mult, config
            ),
            fires=expansion >= config.volatility_fire_mult,
            holds=expansion >= config.volatility_clear_mult,
        )

    return reads


# ─────────────────────────────────────────────────────────────────────────────
# Structural events (state machine → events)
# ─────────────────────────────────────────────────────────────────────────────


def structural_event(
    symbol: str,
    event_type: EventType,
    direction: Direction | None,
    ts: float,
    *,
    magnitude: float = 0.0,
    unit: str = "",
    qualifier: str = "",
    config: EventConfig = DEFAULT_EVENT_CONFIG,
) -> MarketEvent:
    """Mints a discrete event from a detector that lives outside this module.

    Used by the scanner for the 1m CHoCH read (`smc.micro_structure`), which is
    deliberately not imported here — the event layer stays ignorant of *what*
    detects a structural break, and only owns what happens to it afterwards.
    """
    score = {
        "CHOCH": config.choch_score,
        "STRUCTURE_BREAK": config.structure_break_score,
        "CONTINUATION": config.continuation_score,
        "PULLBACK": config.pullback_score,
        "INVALIDATION": config.invalidation_score,
    }.get(event_type, config.event_score_floor)
    return MarketEvent(
        symbol=symbol,
        type=event_type,
        direction=direction,
        ts=ts,
        last_seen_ts=ts,
        magnitude=magnitude,
        peak_magnitude=magnitude,
        unit=unit,
        score=score,
        peak_score=score,
        qualifier=qualifier,
    )


def structural_events(
    previous: Candidate | None,
    current: Candidate,
    config: EventConfig = DEFAULT_EVENT_CONFIG,
) -> list[MarketEvent]:
    """Turns one tick of `smc.momentum` state-machine movement into discrete
    events.

    Two sources: transitions appended to `history` since the previous tick, and
    a new impulse extreme printed *after* a pullback — which is a real break of
    the prior swing (HH on a bullish leg, LL on a bearish one) rather than the
    initial impulse simply drifting further.
    """
    events: list[MarketEvent] = []
    seen = len(previous.history) if previous is not None else 0

    for transition in current.history[seen:]:
        if transition.to_state == "PULLBACK":
            events.append(
                MarketEvent(
                    symbol=current.symbol,
                    type="PULLBACK",
                    direction=current.direction,
                    ts=transition.ts,
                    last_seen_ts=transition.ts,
                    magnitude=round(current.retrace_pct, 2),
                    peak_magnitude=round(current.retrace_pct, 2),
                    unit="%",
                    score=config.pullback_score,
                    peak_score=config.pullback_score,
                )
            )
        elif transition.to_state == "CONTINUATION":
            events.append(
                MarketEvent(
                    symbol=current.symbol,
                    type="CONTINUATION",
                    direction=current.direction,
                    ts=transition.ts,
                    last_seen_ts=transition.ts,
                    magnitude=round(current.price, 8),
                    peak_magnitude=round(current.price, 8),
                    unit="price",
                    score=config.continuation_score,
                    peak_score=config.continuation_score,
                )
            )
        elif transition.to_state == "INVALID":
            events.append(
                MarketEvent(
                    symbol=current.symbol,
                    type="INVALIDATION",
                    direction=current.direction,
                    ts=transition.ts,
                    last_seen_ts=transition.ts,
                    magnitude=round(current.retrace_pct, 2),
                    peak_magnitude=round(current.retrace_pct, 2),
                    unit="%",
                    score=config.invalidation_score,
                    peak_score=config.invalidation_score,
                )
            )

    if (
        previous is not None
        and previous.state in ("PULLBACK", "CONTINUATION")
        and current.impulse_extreme != previous.impulse_extreme
    ):
        events.append(
            MarketEvent(
                symbol=current.symbol,
                type="STRUCTURE_BREAK",
                direction=current.direction,
                ts=current.updated_at,
                last_seen_ts=current.updated_at,
                magnitude=round(current.impulse_extreme, 8),
                peak_magnitude=round(current.impulse_extreme, 8),
                unit="price",
                score=config.structure_break_score,
                peak_score=config.structure_break_score,
                qualifier="HH" if current.direction == "bullish" else "LL",
            )
        )

    return events


# ─────────────────────────────────────────────────────────────────────────────
# Tracker
# ─────────────────────────────────────────────────────────────────────────────


def families_of(live: Sequence[MarketEvent]) -> dict[str, float]:
    """Best severity per independent family among the live events.

    Family-less events (cooling, pullback, invalidation) are excluded: they
    describe a situation that already exists rather than evidence that one is
    starting.
    """
    best: dict[str, float] = {}
    for event in live:
        family = EVENT_FAMILY.get(event.type, "")
        if not family:
            continue
        best[family] = max(best.get(family, 0.0), event.score)
    return best


@dataclass(frozen=True, slots=True)
class Qualification:
    """Whether a symbol's live events actually tell a story together.

    A lone observation is not a situation, however large it is: a displacement
    with nobody trading it, a volume spike price ignored, a quiet minute after
    nothing. Qualification requires a *relationship* between independent
    families, and `combo` names which one so the reasoning stays inspectable.
    """

    qualified: bool
    tier: QualityTier
    combo: str
    families: tuple[str, ...]

    @property
    def strong(self) -> bool:
        return self.tier in ("MEDIUM", "HIGH")


UNQUALIFIED = Qualification(qualified=False, tier="NONE", combo="", families=())


def qualify(live: Sequence[MarketEvent]) -> Qualification:
    """Names the relationship the live events form, if any.

    The three that count, all requiring two independent families:

    * `displacement+participation` — a move with real activity behind it;
    * `anomaly+response`          — abnormal activity price actually reacted to;
    * `structure+activity`        — a structural break with the tape to match.

    Anything else is an observation, not a situation, and is rejected.
    """
    families = families_of(live)
    names = tuple(sorted(families))
    price = "PRICE" in families
    participation = "PARTICIPATION" in families
    volatility = "VOLATILITY" in families
    structure = "STRUCTURE" in families

    if structure and (participation or price):
        combo = "structure+activity"
    elif price and participation:
        combo = "displacement+participation"
    elif participation and volatility:
        combo = "anomaly+response"
    else:
        return Qualification(qualified=False, tier="NONE", combo="", families=names)

    if structure and len(families) >= 3:
        tier: QualityTier = "HIGH"
    elif len(families) >= 3 or (price and participation):
        tier = "MEDIUM"
    else:
        tier = "LOW"
    return Qualification(qualified=True, tier=tier, combo=combo, families=names)


def _promote(
    tracker: SymbolTracker,
    now: float,
    config: EventConfig,
) -> TrackerState:
    """The only place a state advances. Monotone by construction: every branch
    returns either the current state or a strictly stronger one, and each needs
    `min_state_seconds` of dwell behind it."""
    if tracker.state == "FADED":
        return "FADED"
    if now - tracker.state_since < config.min_state_seconds:
        return tracker.state

    structural = any(event.type in STRUCTURAL_TYPES for event in tracker.timeline)
    if structural and tracker.state != "CONFIRMED":
        return "CONFIRMED"
    # Ageing alone no longer promotes anything: an old lone observation is a
    # stale observation, not a developing situation. Only a genuine
    # relationship between independent families moves a card forward.
    if (
        tracker.state == "NEW"
        and tracker.qualification.qualified
        and len(tracker.qualification.families) >= config.developing_min_event_types
    ):
        return "DEVELOPING"
    return tracker.state


def _direction_of(events: Sequence[MarketEvent]) -> Direction | None:
    for event in sorted(events, key=lambda e: (-EVENT_PRIORITY.get(e.type, 0), e.ts)):
        if event.direction is not None:
            return event.direction
    return None


def advance_tracker(
    tracker: SymbolTracker | None,
    metrics: WindowMetrics,
    now: float,
    config: EventConfig = DEFAULT_EVENT_CONFIG,
    *,
    structural: Sequence[MarketEvent] = (),
    context: MarketContext | None = None,
    context_config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
    in_pullback: bool = False,
) -> SymbolTracker | None:
    """Advances one symbol's durable state by one tick.

    Pure. Returns `None` when there is nothing to track (no existing tracker
    and nothing fired), a new `SymbolTracker` otherwise — never mutates its
    input. Drop decisions are the caller's, via `should_drop_tracker`.

    `context` is the slow lane's latest read for this symbol, or `None` when
    the cache has nothing yet — in which case the tracker keeps whatever it
    already had. The fast lane never waits on the slow one.
    """
    live: dict[EventType, MarketEvent] = {}
    if tracker is not None:
        for event in tracker.events:
            if not event.is_expired(now, config):
                live[event.type] = event

    timeline: tuple[MarketEvent, ...] = tracker.timeline if tracker is not None else ()
    direction = tracker.direction if tracker is not None else None
    had_anomaly = (
        any(event.type == "VOLUME_ANOMALY" for event in timeline) or "VOLUME_ANOMALY" in live
    )

    reads = evaluate_conditions(
        metrics,
        config,
        direction=direction,
        had_anomaly=had_anomaly,
        in_pullback=in_pullback,
    )
    fired: list[MarketEvent] = []

    for event_type, read in reads.items():
        existing = live.get(event_type)
        if existing is not None:
            if read.holds:
                # Refresh, never re-mint: identity and `ts` survive, so the
                # card's "detected Ns ago" keeps counting from the real start.
                live[event_type] = replace(
                    existing,
                    last_seen_ts=now,
                    magnitude=read.magnitude,
                    peak_magnitude=(
                        read.magnitude
                        if abs(read.magnitude) > abs(existing.peak_magnitude)
                        else existing.peak_magnitude
                    ),
                    # Severity follows the live reading, so a cooling anomaly
                    # stops propping up the card's score; the high-water mark
                    # is kept separately.
                    score=read.score,
                    peak_score=max(existing.peak_score, read.score),
                    direction=existing.direction or read.direction,
                )
            continue
        if read.fires:
            minted = MarketEvent(
                symbol=metrics.symbol,
                type=read.type,
                direction=read.direction,
                ts=now,
                last_seen_ts=now,
                magnitude=read.magnitude,
                peak_magnitude=read.magnitude,
                unit=read.unit,
                score=read.score,
                peak_score=read.score,
            )
            live[event_type] = minted
            fired.append(minted)

    for event in structural:
        existing = live.get(event.type)
        if existing is not None and event.ts - existing.ts < config.structural_dedupe_seconds:
            continue
        live[event.type] = event
        fired.append(event)

    if tracker is None and not live:
        return None

    events = tuple(sorted(live.values(), key=lambda e: e.ts))
    if fired:
        timeline = (*timeline, *sorted(fired, key=lambda e: e.ts))[-config.timeline_max :]

    raw = _score_tracker(events, config)
    qualification = qualify(events)
    invalidated = any(event.type == "INVALIDATION" for event in events)
    # Retain the last known context when the slow lane has nothing new.
    resolved_context = context if context is not None else (
        tracker.context if tracker is not None else None
    )

    if tracker is None:
        first_event_at = min(event.ts for event in events)
        direction = _direction_of(events)
        return SymbolTracker(
            symbol=metrics.symbol,
            state="FADED" if invalidated else "NEW",
            direction=direction,
            events=events,
            timeline=timeline,
            raw_score=raw,
            display_score=raw,
            peak_score=raw,
            first_event_at=first_event_at,
            last_event_at=max(event.ts for event in events),
            last_active_ts=now,
            state_since=first_event_at,
            updated_at=now,
            qualification=qualification,
            context=resolved_context,
            alignment=classify(direction, resolved_context, now, context_config),
        )

    # EWMA rather than the raw score: the number on the card drifts instead of
    # jumping, which is also what keeps the ranking from reshuffling.
    display = round(
        config.display_alpha * raw + (1.0 - config.display_alpha) * tracker.display_score, 2
    )
    direction = tracker.direction or _direction_of(events)
    working = replace(
        tracker,
        events=events,
        timeline=timeline,
        direction=direction,
        raw_score=raw,
        display_score=display,
        peak_score=max(tracker.peak_score, raw),
        last_event_at=max((event.ts for event in events), default=tracker.last_event_at),
        last_active_ts=now if events else tracker.last_active_ts,
        updated_at=now,
        qualification=qualification,
        context=resolved_context,
        alignment=classify(direction, resolved_context, now, context_config),
    )
    if invalidated and working.state != "FADED":
        return replace(working, state="FADED", state_since=now)
    next_state = _promote(working, now, config)
    if next_state != working.state:
        return replace(working, state=next_state, state_since=now)
    return working


def should_drop_tracker(
    tracker: SymbolTracker, now: float, config: EventConfig = DEFAULT_EVENT_CONFIG
) -> bool:
    """True once a tracker has nothing left to say. A faded tracker lives out
    `faded_ttl_seconds`; any other one survives its last live event by
    `tracker_grace_seconds`, so a symbol never disappears the moment its tape
    goes quiet."""
    if tracker.state == "FADED":
        return now - tracker.state_since >= config.faded_ttl_seconds
    if tracker.events:
        return False
    return now - tracker.last_active_ts >= config.tracker_grace_seconds


@dataclass(frozen=True, slots=True)
class SymbolTracker:
    """One symbol's durable radar state: the events that are still live, the
    full sequence of what happened, and the UI state derived from both.

    Immutable, like `Candidate` — `advance_tracker` returns a new instance, so
    a caller can diff two ticks to see exactly what changed.
    """

    symbol: str
    state: TrackerState
    direction: Direction | None
    # Live events (active or lingering inside their TTL), oldest first.
    events: tuple[MarketEvent, ...]
    # Append-only log of every event ever minted for this tracker, capped at
    # `timeline_max`. This is what makes "what happened here" answerable.
    timeline: tuple[MarketEvent, ...]

    raw_score: float
    display_score: float
    peak_score: float

    first_event_at: float
    last_event_at: float
    last_active_ts: float
    state_since: float
    updated_at: float

    # What relationship the live events form, and how strong it is. `NONE`
    # means the symbol has observations but no situation — it must never be
    # promoted or surfaced on that basis.
    qualification: Qualification = UNQUALIFIED
    # Slow-lane context (4H/1H/15m/5m), supplied by the caller's cache and
    # *retained* between refreshes — the fast lane must never be blocked
    # waiting for it, and a momentarily missing read must not blank the badge.
    context: MarketContext | None = None
    # How this tracker's direction sits against that context. Recomputed each
    # tick, but from inputs that barely move, so it is as stable as they are.
    alignment: Alignment = UNKNOWN_ALIGNMENT

    @property
    def is_terminal(self) -> bool:
        return self.state == "FADED"

    @property
    def newest_event_ts(self) -> float:
        """When this symbol last produced *any* event. Freshness is measured
        against this rather than the first one — an old situation only stays
        alive while something new keeps extending it."""
        return max((event.ts for event in self.events), default=self.first_event_at)

    def newest_structural_ts(self) -> float:
        """…and when a *structural* event last landed. Only these can keep an
        ageing card in DEVELOPING."""
        return max(
            (event.ts for event in self.events if event.type in STRUCTURAL_TYPES),
            default=0.0,
        )

    def headline(
        self, now: float, config: EventConfig = DEFAULT_EVENT_CONFIG
    ) -> MarketEvent | None:
        """The event the card leads with. Active events outrank lingering ones,
        then explanatory priority, then score, then recency — a total order, so
        the headline only changes when something genuinely changed."""
        if not self.events:
            return None
        return max(
            self.events,
            key=lambda e: (
                e.is_active(now, config),
                EVENT_PRIORITY.get(e.type, 0),
                e.score,
                e.ts,
            ),
        )


_STATE_RANK: dict[str, int] = {"NEW": 0, "DEVELOPING": 1, "CONFIRMED": 2, "FADED": 3}


def _score_tracker(live: Sequence[MarketEvent], config: EventConfig) -> float:
    """Score built only from **independent** evidence.

    The mean severity across distinct families, scaled by how much of the
    evidence space is covered. The consequence is deliberate: a lone extreme
    reading cannot produce a top score, and every card at 90+ genuinely has
    several unrelated things agreeing. Family-less events contribute nothing.
    """
    families = families_of(live)
    if not families:
        return 0.0
    mean_severity = sum(families.values()) / len(families)
    span = max(config.family_scale - 1.0, _EPS)
    coverage = config.min_family_coverage + (1.0 - config.min_family_coverage) * _clip(
        (len(families) - 1) / span
    )
    return round(_clip(mean_severity * coverage, 0.0, 100.0), 2)


# ─────────────────────────────────────────────────────────────────────────────
# Ranking
# ─────────────────────────────────────────────────────────────────────────────


def rank_key(
    tracker: SymbolTracker, config: EventConfig = DEFAULT_EVENT_CONFIG
) -> tuple[float, float, str]:
    """Sort key built for *stability*, not precision.

    Scores are compared in buckets of `rank_bucket`, so two candidates a
    fraction of a point apart never trade places tick to tick. Inside a bucket
    the tiebreak is age (oldest first) — a value that cannot move — with symbol
    last so the order is total and therefore deterministic.
    """
    bucket = math.floor(tracker.display_score / config.rank_bucket)
    return (-bucket, tracker.first_event_at, tracker.symbol)


def rank_trackers(
    trackers: Sequence[SymbolTracker], config: EventConfig = DEFAULT_EVENT_CONFIG
) -> list[SymbolTracker]:
    return sorted(trackers, key=lambda t: rank_key(t, config))


def state_rank(state: TrackerState) -> int:
    return _STATE_RANK[state]
