"""MOMENTUM RADAR — realtime short-horizon momentum detector + state machine.

The discovery layer behind `/discover`. Answers one question — *what is moving
RIGHT NOW* — over 1m/3m/5m windows, with 15m carried as context only. It is a
**candidate/radar layer, not a trade signal**: nothing here says long/short,
sizes anything, or writes a record. Detailed SMC reads and execution stay on
the token page (`smc.evaluate`).

Deliberately outside the trading engine, like `spike.py` / `rally_watcher.py` /
`reaccumulation.py`: no `ENGINE_VERSION`, no decision/trigger semantics, its own
`MOMENTUM_VERSION` provenance stamp.

## Purity contract

Everything in this module is pure: no I/O, no clock reads, no globals. Callers
pass `WindowMetrics` (already-aggregated rolling state, see
`app.momentum.state`) and an explicit `now`. `advance_candidate` never mutates
its input — it returns a new `Candidate` — so the same (candidate, metrics,
config, now) tuple always yields the same next state. That is what makes the
state machine deterministic and replayable in tests.

## Why not rank by percentage change

A +2% move on 5x relative volume is a better candidate than a +5% move on flat
volume, and a +10% move that finished twenty minutes ago is not a candidate at
all. `momentum_score` therefore blends five normalized components —
displacement, relative volume, trade-rate expansion, volatility expansion and
freshness/acceleration — under configurable weights (`MomentumConfig`). The
freshness term is what demotes a stale move: it reads the *current* 1m rate
against the 5m average rate, so a dead tape collapses the component toward zero
no matter how large the earlier displacement was.

## The state machine

    (none) ──detect──> MOMENTUM ──retrace──> PULLBACK ──reclaim+volume──> CONTINUATION
                          │                     │                             │
                          └────────────┬────────┴─────────────────────────────┘
                                       ▼
                                    INVALID  (terminal)

`CONTINUATION` requires an actual continuation *event* — a reclaim of the
pullback structure with returning volume and fresh displacement in the original
direction. A candidate is never promoted merely for still being green/red.
Every transition records a `Transition(ts, from_state, to_state, reason)` on the
candidate's `history`, so any state on screen can be explained after the fact.

Bullish and bearish are symmetric: every gate reads a signed displacement
against the candidate's own direction, and every threshold is expressed as a
magnitude. The test suite pins the mirror property directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Literal

# Provenance stamp — this module's own version, not ENGINE_VERSION.
MOMENTUM_VERSION = "1.0.0"

Direction = Literal["bullish", "bearish"]
State = Literal["MOMENTUM", "PULLBACK", "CONTINUATION", "INVALID"]

_EPS = 1e-9


# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MomentumConfig:
    """Every threshold and weight the radar uses, in one place.

    Instances are frozen; callers tune with `dataclasses.replace(cfg, ...)`
    (the backend layer builds one from env at import, see
    `app.momentum.config`). Scale fields answer "what value of this input
    saturates its score component at 1.0".
    """

    # ── detection gates ──────────────────────────────────────────────────────
    # A candidate needs meaningful displacement on the fast windows AND real
    # participation behind it. Either fast window may carry the displacement;
    # both volume gates must pass.
    # Which rolling windows the gates read. Scalp works off 1m/3m with 5m as
    # the freshness normalizer; intraday shifts the whole set out to 5m/15m
    # (see `smc.scan_profiles`). Thresholds below are read against *these*
    # windows, so a mode change moves the horizon rather than only the numbers.
    fast_window: str = "1m"
    slow_window: str = "3m"
    trend_window: str = "5m"
    min_displacement_fast_pct: float = 0.45
    min_displacement_slow_pct: float = 0.80
    min_rvol: float = 2.0
    min_trade_rate_mult: float = 1.5
    # Reject whipsaw: 1m and 3m must agree on direction (a 1m spike against a
    # 3m move is a fade, not fresh momentum).
    require_aligned_1m_3m: bool = True

    # ── score scaling ────────────────────────────────────────────────────────
    displacement_scale_pct: float = 3.0
    rvol_scale: float = 6.0
    trade_rate_scale: float = 5.0
    range_expansion_scale: float = 4.0
    accel_scale: float = 2.5

    # ── score weights (validated to sum to 1.0) ──────────────────────────────
    weight_displacement: float = 0.32
    weight_rvol: float = 0.26
    weight_trade_rate: float = 0.14
    weight_range_expansion: float = 0.10
    weight_freshness: float = 0.18

    # ── state machine ────────────────────────────────────────────────────────
    # Retracement is always a fraction of the candidate's own impulse leg
    # (|extreme - origin|), never a raw percentage — a 1% pullback means
    # something different on a 2% leg than on a 12% leg.
    pullback_min_retrace_frac: float = 0.20
    max_retrace_frac: float = 0.66
    healthy_retrace_frac: float = 0.45
    healthy_pullback_rvol: float = 1.20
    # Continuation: price must reclaim this fraction of the pullback's own
    # range (1.0 = a full break of the prior extreme) *and* show fresh
    # displacement on returning volume.
    continuation_reclaim_frac: float = 0.75
    continuation_min_displacement_pct: float = 0.25
    continuation_min_rvol: float = 1.60
    # A hard counter-move kills the candidate outright, whatever the retrace
    # fraction says.
    opposing_displacement_pct: float = 0.90
    opposing_rvol: float = 2.0
    # No meaningful tape for this long → the candidate has gone cold.
    stale_seconds: float = 300.0
    meaningful_move_pct: float = 0.15
    meaningful_rvol: float = 1.5
    # How long an INVALID candidate stays visible in the "recently invalidated"
    # section before the scanner drops it.
    invalid_ttl_seconds: float = 180.0

    def __post_init__(self) -> None:
        total = (
            self.weight_displacement
            + self.weight_rvol
            + self.weight_trade_rate
            + self.weight_range_expansion
            + self.weight_freshness
        )
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"MomentumConfig score weights must sum to 1.0, got {total!r}")


DEFAULT_CONFIG = MomentumConfig()


# ─────────────────────────────────────────────────────────────────────────────
# Inputs
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class WindowMetrics:
    """One symbol's rolling short-window state at one instant.

    Produced by the in-memory aggregator (`app.momentum.state`) from the
    all-market ticker stream — never from a per-symbol REST call. `None` on a
    window means "not enough samples yet" (cold start); gates that need it fail
    closed rather than guessing.

    `window_high`/`window_low` are the observed extremes over the 5m window and
    anchor a new candidate's impulse leg. `last_meaningful_ts` is the last time
    this symbol printed a move or volume burst worth calling an update — it
    drives staleness, not wall-clock arrival of a tick.
    """

    symbol: str
    ts: float
    price: float

    change_1m_pct: float | None = None
    change_3m_pct: float | None = None
    change_5m_pct: float | None = None
    change_15m_pct: float | None = None

    rvol_1m: float | None = None
    rvol_3m: float | None = None
    rvol_5m: float | None = None
    # Carried for the intraday mode, whose working windows are 5m/15m.
    rvol_15m: float | None = None
    trade_rate_mult: float | None = None
    range_expansion: float | None = None
    # Baseline 1m range as a percentage — the symbol's own noise band. What a
    # stop has to sit outside of to be a stop rather than a coin flip.
    volatility_1m_pct: float | None = None

    window_high: float = 0.0
    window_low: float = 0.0

    quote_volume_1m: float = 0.0
    trades_1m: float = 0.0
    quote_volume_24h: float = 0.0
    change_24h_pct: float = 0.0

    last_meaningful_ts: float = 0.0
    # False once the buffer covers every window the gates read.
    warming_up: bool = True


# ─────────────────────────────────────────────────────────────────────────────
# Scoring
# ─────────────────────────────────────────────────────────────────────────────


def _clip(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _ratio_component(value: float | None, scale: float) -> float:
    """Normalizes a 'multiple of baseline' input (1.0 = baseline, no credit)
    onto [0, 1], saturating at `scale`."""
    if value is None or scale <= 1.0:
        return 0.0
    return _clip((value - 1.0) / (scale - 1.0))


def signed_change(metrics: WindowMetrics, direction: Direction, window: str) -> float | None:
    """A window's price change expressed in the candidate's own direction:
    positive = moving with the candidate, negative = moving against it. The one
    place bullish/bearish symmetry is implemented."""
    raw: float | None = getattr(metrics, f"change_{window}_pct")
    if raw is None:
        return None
    return raw if direction == "bullish" else -raw


def window_change(metrics: WindowMetrics, window: str) -> float | None:
    """A window's raw (unsigned-by-direction) price change, by name."""
    value: float | None = getattr(metrics, f"change_{window}_pct", None)
    return value


def window_rvol(metrics: WindowMetrics, window: str) -> float | None:
    """A window's relative volume, by name. `None` when that window has no
    observed rate yet (cold start), so gates fail closed."""
    value: float | None = getattr(metrics, f"rvol_{window}", None)
    return value


def window_minutes(window: str) -> float:
    """Minutes in a window name — the freshness normalizer needs it to compare
    a fast rate against a slower average rate."""
    text = window.strip().lower()
    try:
        return float(text.rstrip("m")) if text.endswith("m") else float(text)
    except ValueError:
        return 1.0


def score_components(
    metrics: WindowMetrics,
    direction: Direction,
    config: MomentumConfig = DEFAULT_CONFIG,
) -> dict[str, float]:
    """The five normalized [0, 1] score inputs, kept separate so the API can
    ship them and a card can explain a score without re-deriving it."""
    change_fast = signed_change(metrics, direction, config.fast_window) or 0.0
    change_slow = signed_change(metrics, direction, config.slow_window) or 0.0
    change_trend = signed_change(metrics, direction, config.trend_window) or 0.0
    fast_minutes = window_minutes(config.fast_window)
    slow_minutes = window_minutes(config.slow_window)
    trend_minutes = window_minutes(config.trend_window)

    # Displacement: the stronger of the two working windows, per-minute
    # normalized so the slower one isn't automatically credited over a sharper
    # move on the faster one.
    displacement = max(
        max(change_fast, 0.0) * (slow_minutes / max(fast_minutes, _EPS)),
        max(change_slow, 0.0),
    )
    displacement_component = _clip(displacement / max(config.displacement_scale_pct, _EPS))

    rvol_component = _ratio_component(
        window_rvol(metrics, config.slow_window) or window_rvol(metrics, config.fast_window),
        config.rvol_scale,
    )
    trade_rate_component = _ratio_component(metrics.trade_rate_mult, config.trade_rate_scale)
    range_component = _ratio_component(metrics.range_expansion, config.range_expansion_scale)

    # Freshness: is the move happening *now*? `accel` compares the current
    # per-minute rate against the trend window's average per-minute rate — a
    # move that has gone quiet collapses this toward zero however large it was,
    # which is what keeps a 20-minute-old +10% below a just-started +2% on
    # expanding volume.
    rate_fast = abs(change_fast) / max(fast_minutes, _EPS)
    rate_trend = abs(change_trend) / max(trend_minutes, _EPS)
    accel = rate_fast / rate_trend if rate_trend > _EPS else (1.0 if rate_fast > _EPS else 0.0)
    freshness_component = _clip(accel / max(config.accel_scale, _EPS))

    return {
        "displacement": round(displacement_component, 4),
        "rvol": round(rvol_component, 4),
        "trade_rate": round(trade_rate_component, 4),
        "range_expansion": round(range_component, 4),
        "freshness": round(freshness_component, 4),
    }


def momentum_score(
    metrics: WindowMetrics,
    direction: Direction,
    config: MomentumConfig = DEFAULT_CONFIG,
) -> tuple[float, dict[str, float]]:
    """Normalized 0-100 momentum score plus its components."""
    components = score_components(metrics, direction, config)
    score = 100.0 * (
        config.weight_displacement * components["displacement"]
        + config.weight_rvol * components["rvol"]
        + config.weight_trade_rate * components["trade_rate"]
        + config.weight_range_expansion * components["range_expansion"]
        + config.weight_freshness * components["freshness"]
    )
    return round(_clip(score, 0.0, 100.0), 2), components


# ─────────────────────────────────────────────────────────────────────────────
# Detection
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MomentumSignal:
    direction: Direction
    score: float
    components: dict[str, float]
    # Every gate's pass/fail, always populated — the radar has to be
    # inspectable, including for the near-misses.
    gates: dict[str, bool]


def detect_momentum(
    metrics: WindowMetrics,
    config: MomentumConfig = DEFAULT_CONFIG,
) -> MomentumSignal | None:
    """Fires when meaningful displacement coincides with elevated
    participation. Returns None if any gate fails or the symbol is still
    warming up."""
    if metrics.warming_up:
        return None
    fast_raw = window_change(metrics, config.fast_window)
    slow_raw = window_change(metrics, config.slow_window)
    if fast_raw is None or slow_raw is None:
        return None

    direction: Direction = "bullish" if slow_raw >= 0 else "bearish"
    change_fast = signed_change(metrics, direction, config.fast_window) or 0.0
    change_slow = signed_change(metrics, direction, config.slow_window) or 0.0
    rvol = window_rvol(metrics, config.slow_window) or window_rvol(metrics, config.fast_window)

    gates = {
        "displacement": (
            change_fast >= config.min_displacement_fast_pct
            or change_slow >= config.min_displacement_slow_pct
        ),
        "rvol": rvol is not None and rvol >= config.min_rvol,
        "trade_rate": (
            metrics.trade_rate_mult is not None
            and metrics.trade_rate_mult >= config.min_trade_rate_mult
        ),
        "aligned": (not config.require_aligned_1m_3m) or change_fast >= 0.0,
    }
    score, components = momentum_score(metrics, direction, config)
    if not all(gates.values()):
        return None
    return MomentumSignal(direction=direction, score=score, components=components, gates=gates)


# ─────────────────────────────────────────────────────────────────────────────
# State machine
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Transition:
    ts: float
    from_state: str
    to_state: State
    reason: str


@dataclass(frozen=True, slots=True)
class Candidate:
    """One tracked symbol's radar state. Immutable — `advance_candidate`
    returns a new instance rather than mutating, so a caller can always diff
    old against new to see what a tick changed."""

    symbol: str
    direction: Direction
    state: State
    score: float
    peak_score: float
    components: dict[str, float]

    detected_at: float
    state_since: float
    updated_at: float

    # Impulse leg anchors. `origin` is the base the move launched from,
    # `extreme` the furthest it has travelled in `direction`.
    impulse_origin: float
    impulse_extreme: float
    # Deepest counter-travel since `impulse_extreme`, i.e. the pullback's own
    # extreme. Equals `impulse_extreme` while no pullback has printed.
    pullback_extreme: float

    price: float
    retrace_pct: float
    reason: str
    # Pullback quality flags — display/explanation only, never a gate.
    health: dict[str, bool] = field(default_factory=dict)
    history: tuple[Transition, ...] = ()

    @property
    def is_terminal(self) -> bool:
        return self.state == "INVALID"


def _leg(candidate: Candidate) -> float:
    return abs(candidate.impulse_extreme - candidate.impulse_origin)


def _travel(candidate: Candidate, price: float) -> float:
    """Signed travel from `price` back toward the origin, in price units."""
    if candidate.direction == "bullish":
        return candidate.impulse_extreme - price
    return price - candidate.impulse_extreme


def retrace_fraction(candidate: Candidate, price: float) -> float:
    """How much of the impulse leg has been given back, as a fraction. 0.0 at
    the extreme, 1.0 back at the origin, >1.0 through it."""
    leg = _leg(candidate)
    if leg <= _EPS:
        return 0.0
    return max(0.0, _travel(candidate, price) / leg)


def _with_transition(
    candidate: Candidate, to_state: State, reason: str, ts: float, **changes: object
) -> Candidate:
    transition = Transition(
        ts=ts, from_state=candidate.state, to_state=to_state, reason=reason
    )
    return replace(
        candidate,
        state=to_state,
        state_since=ts,
        reason=reason,
        history=(*candidate.history, transition),
        **changes,  # type: ignore[arg-type]
    )


def open_candidate(metrics: WindowMetrics, signal: MomentumSignal) -> Candidate:
    """Creates a fresh MOMENTUM candidate. The impulse leg is anchored on the
    observed 5m extremes rather than on the tick price, so the retracement math
    measures the real move from its base."""
    origin = metrics.window_low if signal.direction == "bullish" else metrics.window_high
    extreme = metrics.window_high if signal.direction == "bullish" else metrics.window_low
    # Degenerate buffers (a flat window) would give a zero-length leg; fall
    # back to the tick price so retracement stays defined.
    if abs(extreme - origin) <= _EPS:
        origin = metrics.price
        extreme = metrics.price
    return Candidate(
        symbol=metrics.symbol,
        direction=signal.direction,
        state="MOMENTUM",
        score=signal.score,
        peak_score=signal.score,
        components=signal.components,
        detected_at=metrics.ts,
        state_since=metrics.ts,
        updated_at=metrics.ts,
        impulse_origin=origin,
        impulse_extreme=extreme,
        pullback_extreme=extreme,
        price=metrics.price,
        retrace_pct=0.0,
        reason="momentum detected",
        health={},
        history=(
            Transition(
                ts=metrics.ts, from_state="", to_state="MOMENTUM", reason="momentum detected"
            ),
        ),
    )


def _opposing_displacement(
    candidate: Candidate, metrics: WindowMetrics, config: MomentumConfig
) -> bool:
    """A hard counter-move on real volume — the market rejecting the leg,
    independent of how far the retracement has travelled."""
    against = -(signed_change(metrics, candidate.direction, config.fast_window) or 0.0)
    if against < config.opposing_displacement_pct:
        return False
    rvol = window_rvol(metrics, config.fast_window) or window_rvol(metrics, config.slow_window)
    return rvol is not None and rvol >= config.opposing_rvol


def _is_stale(
    candidate: Candidate, metrics: WindowMetrics, now: float, config: MomentumConfig
) -> bool:
    last = max(metrics.last_meaningful_ts, candidate.detected_at)
    return now - last >= config.stale_seconds


def _pullback_health(
    candidate: Candidate, metrics: WindowMetrics, retrace: float, config: MomentumConfig
) -> dict[str, bool]:
    """A healthy pullback cools off: volume drops, the give-back stays shallow,
    the leg's base holds, and nothing is pushing hard the other way. Display
    only — none of these gate a transition."""
    rvol = window_rvol(metrics, config.fast_window) or window_rvol(metrics, config.slow_window)
    return {
        "volume_cooling": rvol is not None and rvol <= config.healthy_pullback_rvol,
        "shallow": retrace <= config.healthy_retrace_frac,
        "structure_intact": retrace < 1.0,
        "no_opposing": not _opposing_displacement(candidate, metrics, config),
    }


def _invalidation(
    candidate: Candidate, metrics: WindowMetrics, retrace: float, now: float, config: MomentumConfig
) -> str | None:
    """The single invalidation rulebook, shared by every non-terminal state.
    Returns the reason, or None if the candidate survives."""
    if retrace >= 1.0:
        return "structure broken — impulse base lost"
    if retrace >= config.max_retrace_frac:
        return "pullback exceeded threshold"
    if _opposing_displacement(candidate, metrics, config):
        return "strong opposing displacement"
    if _is_stale(candidate, metrics, now, config):
        return "went stale — no meaningful tape"
    return None


def _reclaimed(candidate: Candidate, price: float, config: MomentumConfig) -> bool:
    """Has price recovered `continuation_reclaim_frac` of the pullback's own
    range, back toward (or through) the prior extreme?"""
    span = abs(candidate.impulse_extreme - candidate.pullback_extreme)
    if span <= _EPS:
        return False
    if candidate.direction == "bullish":
        level = candidate.pullback_extreme + config.continuation_reclaim_frac * span
        return price >= level
    level = candidate.pullback_extreme - config.continuation_reclaim_frac * span
    return price <= level


def _continuation_event(
    candidate: Candidate, metrics: WindowMetrics, config: MomentumConfig
) -> bool:
    """CONTINUATION is an event, never a colour. All three must hold: the
    pullback structure is reclaimed, price is accelerating again in the
    original direction, and volume has come back."""
    if not _reclaimed(candidate, metrics.price, config):
        return False
    change_fast = signed_change(metrics, candidate.direction, config.fast_window)
    if change_fast is None or change_fast < config.continuation_min_displacement_pct:
        return False
    rvol = window_rvol(metrics, config.fast_window) or window_rvol(metrics, config.slow_window)
    return rvol is not None and rvol >= config.continuation_min_rvol


def advance_candidate(
    candidate: Candidate,
    metrics: WindowMetrics,
    now: float,
    config: MomentumConfig = DEFAULT_CONFIG,
) -> Candidate:
    """Advances one candidate by one tick. Pure: returns a new `Candidate`,
    never mutates the input. INVALID is terminal — re-entry means a brand new
    candidate via `detect_momentum` + `open_candidate`."""
    if candidate.state == "INVALID":
        return candidate

    price = metrics.price
    bullish = candidate.direction == "bullish"
    prior_extreme = candidate.impulse_extreme

    # Deepen the pullback anchor against the *prior* extreme before extending
    # the leg. Order matters: a tick that prints a new extreme must still be
    # judged against the pullback it just resolved, otherwise the reclaim span
    # collapses to zero and a decisive break of the high would read as "no
    # continuation event".
    prior_pullback = candidate.pullback_extreme
    probe_pullback = min(prior_pullback, price) if bullish else max(prior_pullback, price)
    probe = replace(candidate, pullback_extreme=probe_pullback, price=price)

    extreme = max(prior_extreme, price) if bullish else min(prior_extreme, price)
    made_new_extreme = extreme != prior_extreme
    # A new extreme starts a new leg: the pullback anchor resets to it.
    pullback_extreme = extreme if made_new_extreme else probe_pullback

    score, components = momentum_score(metrics, candidate.direction, config)
    working = replace(
        candidate,
        impulse_extreme=extreme,
        pullback_extreme=pullback_extreme,
        price=price,
        score=score,
        peak_score=max(candidate.peak_score, score),
        components=components,
        updated_at=metrics.ts,
    )
    retrace = retrace_fraction(working, price)
    working = replace(working, retrace_pct=round(retrace * 100.0, 2))

    reason = _invalidation(working, metrics, retrace, now, config)
    if reason is not None:
        return _with_transition(working, "INVALID", reason, metrics.ts, health={})

    if working.state in ("MOMENTUM", "CONTINUATION"):
        if retrace >= config.pullback_min_retrace_frac:
            health = _pullback_health(working, metrics, retrace, config)
            return _with_transition(
                working, "PULLBACK", "retracing from the impulse extreme", metrics.ts, health=health
            )
        return replace(working, health={})

    # PULLBACK
    if _continuation_event(probe, metrics, config):
        return _with_transition(
            working,
            "CONTINUATION",
            "reclaimed the pullback on returning volume",
            metrics.ts,
            # The resumed leg is the new reference for the next pullback.
            pullback_extreme=extreme,
            health={},
        )
    return replace(working, health=_pullback_health(working, metrics, retrace, config))


def expire_candidate(
    candidate: Candidate, now: float, config: MomentumConfig = DEFAULT_CONFIG
) -> Candidate:
    """Marks a candidate INVALID when its symbol has stopped ticking entirely
    (no metrics arriving at all, so `advance_candidate` is never called for
    it). Separate from staleness *within* a tick so both paths stay explicit."""
    if candidate.state == "INVALID":
        return candidate
    if now - candidate.updated_at < config.stale_seconds:
        return candidate
    return _with_transition(candidate, "INVALID", "went stale — no meaningful tape", now, health={})


def should_drop(candidate: Candidate, now: float, config: MomentumConfig = DEFAULT_CONFIG) -> bool:
    """True once an INVALID candidate has outlived its display TTL."""
    if candidate.state != "INVALID":
        return False
    return now - candidate.state_since >= config.invalid_ttl_seconds


def rank_key(candidate: Candidate) -> tuple[float, float, str]:
    """Sort key for top-K ranking within a state section: score first,
    freshness (most recently updated) as the tiebreak, symbol last so the order
    is total and therefore stable across ties."""
    return (-candidate.score, -candidate.updated_at, candidate.symbol)


def rank(candidates: list[Candidate]) -> list[Candidate]:
    return sorted(candidates, key=rank_key)


def pressure_label(candidate: Candidate) -> str:
    """Short human phrase for the card's direction/pressure line. Descriptive
    only — it never implies a trade."""
    if candidate.state == "INVALID":
        return "momentum failed"
    strong = candidate.components.get("rvol", 0.0) >= 0.5
    if candidate.direction == "bullish":
        return "heavy buy pressure" if strong else "buyers stepping in"
    return "heavy sell pressure" if strong else "sellers stepping in"
