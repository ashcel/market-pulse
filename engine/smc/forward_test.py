"""FORWARD TEST — what would have happened if we had acted on this setup.

Research infrastructure, not trading. Nothing here places an order, and no
field on a settled record ever came from a candle that closed after detection.

## The question

    "If I had seen this exact setup at that exact moment, and followed the
     entry, invalidation, target and trailing rules decided *then*, what would
     have happened?"

Not "could we have made money knowing what happened next". The distinction is
the whole design, and it is enforced structurally rather than by discipline:

* `SetupSnapshot` is a frozen dataclass built once at detection and **never
  passed to any function that could return a modified copy**. There is no
  `replace()` of a snapshot anywhere in this module.
* The lifecycle lives on `PaperPosition`, a separate object. Advancing it can
  never reach back into the hypothesis.
* `advance_position` takes one price and one timestamp. It cannot see the
  future because it is never given it.

## Lifecycle

    (confirmed) → PENDING_ENTRY → ACTIVE → TARGET_HIT | INVALIDATED | EXPIRED
                       └────────────────────────────────────────→ NO_FILL

`NO_FILL` is deliberately not a loss. A setup that never traded into its own
entry zone tells you the *setup* was untradable, which is a different failure
from a setup that filled and went the wrong way — and pooling the two would
quietly flatter every statistic that follows.

## Settlement ordering

Priority is target, invalidation, then timeout — but ordering is decided by
*arrival*, not by rule: each call sees one price at one instant, and a single
price cannot be on both sides of an entry at once. Feeding the radar's ~1s tick
stream therefore resolves same-bar ambiguity by construction, which is what
"use the highest-resolution data available" means here. A caller replaying
coarse candles would inherit that coarseness; that is the caller's choice to
document, not something this module can paper over.

## Trailing stops

`initial_invalidation` is immutable for the life of the record. Trailing moves
`active_stop` only, only in the favourable direction, and every move is
appended to `trailing_updates`, so the whole stop history survives settlement.

## Fill model

A settled exit fills at **the resting order's own price** — the stop for an
invalidation, the target for a target hit — not at the observation that
revealed the level had been crossed. The observation decides *whether*, never
*where*.

This matters more than it sounds. Observations arrive on a poll, so the first
price seen past a level is already some distance beyond it, and that distance
is **signed against the position on both sides**: a stop is discovered below
where it sat, a target above. Settling at the observed price therefore charges
the stop with slippage it never had and credits the target with an overshoot no
limit order would have received. Generation 4 paid a mean 0.174R past its stops
— 13.9R across 80 trades, against a modelled slippage of 0.02% — while its four
target hits collected 2.97R of overshoot in the other direction. Neither number
is a property of the strategy; both are properties of the sampling rate.

The cost of actually crossing the spread is modelled once, explicitly, in
`taker_fee_pct` + `slippage_pct`. Charging it a second time through the
observation price is not conservatism, it is a bias whose size is set by how
often the recorder happens to look.

The assumption this makes is stated plainly: the stop and target rest on the
book and fill at their level. A true gap through a resting stop would fill
worse, and this model will not show that. Prices come from the radar's ~1s
tick stream, so the window in which a gap can hide is that tick.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field, fields, replace
from typing import Any, Literal

FORWARD_TEST_VERSION = "1.2.0"

Direction = Literal["bullish", "bearish"]

Status = Literal[
    "PENDING_ENTRY",
    "ACTIVE",
    "TARGET_HIT",
    "INVALIDATED",
    "EXPIRED",
    "NO_FILL",
]

#: Statuses that are still being observed.
OPEN_STATUSES: frozenset[str] = frozenset({"PENDING_ENTRY", "ACTIVE"})
#: …and the ones that will never change again.
SETTLED_STATUSES: frozenset[str] = frozenset({"TARGET_HIT", "INVALIDATED", "EXPIRED", "NO_FILL"})

EventType = Literal[
    "SETUP_CONFIRMED",
    "ENTRY_ZONE_TOUCHED",
    "ENTRY_FILLED",
    "TRAIL_ACTIVATED",
    "TRAIL_UPDATED",
    "TARGET_HIT",
    "INVALIDATED",
    "EXPIRED",
]

TrailingMode = Literal["NONE", "R_MULTIPLE"]

_EPS = 1e-9


# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ForwardTestConfig:
    """The rules, fixed before the setup is observed.

    Every one of these is part of the hypothesis: changing them changes what a
    recorded result *means*, which is why the config hash is stamped onto each
    record (see `app.research`).
    """

    # The entry zone extends from the reference entry *toward* the
    # invalidation, as a fraction of the risk distance. A setup you would only
    # take at a better price is a different setup from one you would chase.
    entry_zone_risk_frac: float = 0.35
    # How long a setup may wait for its entry before it is written off as
    # untradable.
    entry_window_seconds: float = 900.0
    # How long a filled setup may run before it is closed at the market.
    max_holding_seconds: float = 7_200.0

    # ── costs ───────────────────────────────────────────────────────────────
    # Gross R flatters a short-horizon strategy badly, because cost is a fixed
    # percentage of *price* while R is measured against the stop. A 0.1% round
    # trip is ~10% of a 1% scalp stop and ~2% of a 5% swing stop, so omitting
    # it does not merely shift results — it shifts them differently per
    # horizon, which is exactly the comparison this dataset exists to make.
    taker_fee_pct: float = 0.05
    slippage_pct: float = 0.02

    # Trailing. NONE keeps the structural stop for the whole trade.
    trailing_mode: TrailingMode = "R_MULTIPLE"
    # Move to breakeven once the trade is this many R in favour…
    trailing_activation_r: float = 1.0
    # …and thereafter keep the stop this many R behind the best price.
    trailing_distance_r: float = 1.0

    def __post_init__(self) -> None:
        if not 0.0 <= self.entry_zone_risk_frac < 1.0:
            raise ValueError("entry_zone_risk_frac must be in [0, 1)")
        if self.entry_window_seconds <= 0 or self.max_holding_seconds <= 0:
            raise ValueError("windows must be positive")
        if self.trailing_distance_r <= 0:
            raise ValueError("trailing_distance_r must be positive")
        if self.taker_fee_pct < 0 or self.slippage_pct < 0:
            raise ValueError("costs cannot be negative")

    @property
    def round_trip_cost_pct(self) -> float:
        """Entry + exit, fee + slippage, as a percentage of price."""
        return 2.0 * (self.taker_fee_pct + self.slippage_pct)


DEFAULT_FORWARD_TEST_CONFIG = ForwardTestConfig()


# ─────────────────────────────────────────────────────────────────────────────
# The immutable hypothesis
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class SetupSnapshot:
    """Everything known about the setup **at detection**, and nothing else.

    Frozen, and never rebuilt: the recorder constructs one of these once and
    the settlement engine only ever reads it. Fields are stored flat and
    pre-computed because recomputing any of them later — from data that did not
    exist at `detected_at` — is precisely the lookahead this module exists to
    prevent.
    """

    symbol: str
    market: str
    mode: str
    direction: Direction
    detected_at: float

    # Where the setup was in its lifecycle, and how good the evidence was.
    state: str
    tier: str
    combo: str
    families: tuple[str, ...]
    score: float

    # The plan. `reference_entry` is the price the engine quoted; the zone is
    # derived from it once, here.
    entry_low: float
    entry_high: float
    reference_entry: float
    initial_invalidation: float
    target: float
    target_kind: str
    potential_rr: float

    # Higher-timeframe context, frozen as read.
    htf_bias: str
    htf_agreement: float
    alignment: str
    alignment_level: str
    structure_trend: str

    # The evidence behind the call.
    headline_event: str
    event_age_seconds: float
    rvol: float | None
    change_1m_pct: float | None
    change_3m_pct: float | None
    change_5m_pct: float | None
    change_15m_pct: float | None
    retrace_frac: float | None
    pullback_volume_ratio: float | None
    completion_evidence: tuple[str, ...]
    micro_choch: bool
    liquidity_target: bool

    # Provenance — which exact detector produced this.
    engine_version: str
    momentum_version: str
    events_version: str
    context_version: str
    forward_test_version: str
    config_hash: str
    git_sha: str

    # Slow structural context at detection (reaccumulation state + score), or
    # "" / 0.0 when the symbol had none. Recorded so outcomes can later be
    # segmented by whether a fast event had slow backing — deliberately *not*
    # a filter, because nothing yet says it earns one.
    structural_state: str = ""
    structural_score: float = 0.0

    # What the whole tape was doing at detection (`smc.market_regime`), and the
    # numbers the label came from. Recorded, never consulted: a cohort run
    # through a trending afternoon and one run through overnight chop are not
    # comparable, and without this the record cannot tell them apart.
    regime: str = "unknown"
    regime_breadth: float = 0.0
    regime_energy_pct: float = 0.0
    regime_sample: int = 0

    @property
    def risk(self) -> float:
        """Distance from the reference entry to the structural invalidation."""
        return abs(self.reference_entry - self.initial_invalidation)

    @property
    def reward(self) -> float:
        return abs(self.target - self.reference_entry)


def entry_zone(
    direction: Direction,
    reference: float,
    invalidation: float,
    config: ForwardTestConfig = DEFAULT_FORWARD_TEST_CONFIG,
) -> tuple[float, float]:
    """The band a fill would be accepted in, derived once at detection.

    It extends from the reference price *toward* the invalidation: you are
    waiting for a better price, never chasing a worse one. Returned low-first
    so callers never have to think about direction.
    """
    risk = abs(reference - invalidation)
    band = risk * config.entry_zone_risk_frac
    # Toward the invalidation: up for a bearish setup (which sells into a
    # bounce), down for a bullish one.
    edge = reference + band if direction == "bearish" else reference - band
    return (min(reference, edge), max(reference, edge))


# ─────────────────────────────────────────────────────────────────────────────
# Lifecycle events
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class LifecycleEvent:
    """One append-only transition. Never revised, never deleted."""

    type: EventType
    ts: float
    price: float
    # Small, flat state capture — enough to reconstruct why the transition
    # happened without re-deriving it from market data.
    detail: dict[str, float | str | bool] = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# The mutable half: the paper position
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class PaperPosition:
    """The lifecycle state of one hypothesis under live observation.

    Immutable in the same sense as the rest of the engine: `advance_position`
    returns a new instance. What changes across instances is only ever
    *observation* — the hypothesis itself lives in `SetupSnapshot`.
    """

    status: Status
    # Set when price first trades into the entry zone, and when it fills.
    zone_touched_at: float | None = None
    entered_at: float | None = None
    entry_price: float | None = None

    # The stop actually in force. Starts as the structural invalidation and
    # only ever moves in the trade's favour.
    active_stop: float = 0.0
    trailing_mode: TrailingMode = "NONE"
    trailing_activated_at: float | None = None
    trailing_updates: tuple[tuple[float, float], ...] = ()

    # Excursions, in percent from the fill (signed so positive always favours
    # the thesis) and in R.
    mfe_pct: float = 0.0
    mae_pct: float = 0.0
    mfe_r: float = 0.0
    mae_r: float = 0.0
    # Realized R before costs, and what the round trip took out of it. Kept
    # separately so a later cost assumption can be re-derived without
    # re-running the tape.
    gross_r: float = 0.0
    cost_r: float = 0.0
    # …and while still waiting, measured from the reference entry.
    pending_mfe_pct: float = 0.0
    pending_mae_pct: float = 0.0

    best_price: float | None = None
    worst_price: float | None = None

    settled_at: float | None = None
    exit_price: float | None = None
    exit_reason: str = ""
    realized_r: float = 0.0
    last_price: float = 0.0
    updated_at: float = 0.0

    @property
    def is_open(self) -> bool:
        return self.status in OPEN_STATUSES

    @property
    def is_settled(self) -> bool:
        return self.status in SETTLED_STATUSES

    @property
    def filled(self) -> bool:
        return self.entered_at is not None

    @property
    def trailing_active(self) -> bool:
        return self.trailing_activated_at is not None


def open_position(
    snapshot: SetupSnapshot,
    now: float,
    price: float,
    config: ForwardTestConfig = DEFAULT_FORWARD_TEST_CONFIG,
) -> tuple[PaperPosition, list[LifecycleEvent]]:
    """Starts observing a confirmed setup. Always begins PENDING_ENTRY — a
    setup being detected is not a fill, however good it looks."""
    position = PaperPosition(
        status="PENDING_ENTRY",
        active_stop=snapshot.initial_invalidation,
        trailing_mode=config.trailing_mode,
        last_price=price,
        updated_at=now,
    )
    event = LifecycleEvent(
        type="SETUP_CONFIRMED",
        ts=now,
        price=price,
        detail={
            "state": snapshot.state,
            "tier": snapshot.tier,
            "direction": snapshot.direction,
            "entry_low": snapshot.entry_low,
            "entry_high": snapshot.entry_high,
            "invalidation": snapshot.initial_invalidation,
            "target": snapshot.target,
            "potential_rr": snapshot.potential_rr,
        },
    )
    return position, [event]


def _signed_move(direction: Direction, reference: float, price: float) -> float:
    """Percent move from `reference`, positive when it favours the thesis."""
    if reference <= _EPS:
        return 0.0
    raw = (price - reference) / reference * 100.0
    return raw if direction == "bullish" else -raw


def _r_multiple(snapshot: SetupSnapshot, entry: float, price: float) -> float:
    """How many R the trade is worth at `price`, from the actual fill. Gross —
    costs are applied once, at settlement."""
    risk = abs(entry - snapshot.initial_invalidation)
    if risk <= _EPS:
        return 0.0
    move = (price - entry) if snapshot.direction == "bullish" else (entry - price)
    return move / risk


def unrealized_r(
    snapshot: SetupSnapshot,
    position: PaperPosition,
    config: ForwardTestConfig = DEFAULT_FORWARD_TEST_CONFIG,
) -> float:
    """What an open position is worth right now, net of the round trip.

    Marked at the last observed price and charged the full cost, so a floating
    number is never flattered relative to the settled one it will become. Zero
    before a fill: there is nothing to mark.
    """
    if position.entry_price is None or position.is_settled:
        return 0.0
    entry = position.entry_price
    gross = _r_multiple(snapshot, entry, position.last_price or entry)
    return round(gross - cost_in_r(snapshot, entry, config), 4)


def cost_in_r(snapshot: SetupSnapshot, entry: float, config: ForwardTestConfig) -> float:
    """The round trip expressed in R for this particular trade.

    Cost is a share of price; R is a share of the stop distance. The narrower
    the stop, the larger the same fee looms — which is precisely why a scalp
    and a swing cannot be compared on gross R.
    """
    risk = abs(entry - snapshot.initial_invalidation)
    if risk <= _EPS or entry <= _EPS:
        return 0.0
    return (entry * config.round_trip_cost_pct / 100.0) / risk


def _in_zone(snapshot: SetupSnapshot, price: float) -> bool:
    return snapshot.entry_low - _EPS <= price <= snapshot.entry_high + _EPS


def _beyond_target(snapshot: SetupSnapshot, price: float) -> bool:
    if snapshot.direction == "bullish":
        return price >= snapshot.target
    return price <= snapshot.target


def _beyond_stop(snapshot: SetupSnapshot, stop: float, price: float) -> bool:
    if snapshot.direction == "bullish":
        return price <= stop
    return price >= stop


def _trail_to(
    snapshot: SetupSnapshot,
    position: PaperPosition,
    entry: float,
    best_price: float,
    config: ForwardTestConfig,
) -> float | None:
    """Where the trailing stop would sit, or `None` if it should not move.

    Only ever tightens: a trailing stop that can loosen is not a stop, and
    letting one drift the wrong way would silently rewrite risk after the fact.
    """
    if config.trailing_mode != "R_MULTIPLE":
        return None
    risk = abs(entry - snapshot.initial_invalidation)
    if risk <= _EPS:
        return None
    best_r = _r_multiple(snapshot, entry, best_price)
    if best_r < config.trailing_activation_r:
        return None
    # Breakeven at activation, then `trailing_distance_r` behind the extreme.
    trailed = best_price - risk * config.trailing_distance_r
    if snapshot.direction == "bearish":
        trailed = best_price + risk * config.trailing_distance_r
    candidate = max(trailed, entry) if snapshot.direction == "bullish" else min(trailed, entry)
    if snapshot.direction == "bullish" and candidate <= position.active_stop + _EPS:
        return None
    if snapshot.direction == "bearish" and candidate >= position.active_stop - _EPS:
        return None
    return candidate


def advance_position(
    snapshot: SetupSnapshot,
    position: PaperPosition,
    price: float,
    now: float,
    config: ForwardTestConfig = DEFAULT_FORWARD_TEST_CONFIG,
) -> tuple[PaperPosition, list[LifecycleEvent]]:
    """Advances one paper position by one observation.

    Pure and total: `(snapshot, position, price, now)` fully determine the
    result, which is what makes a recorded dataset replayable. A settled
    position is returned untouched — history does not get revised.
    """
    if position.is_settled:
        return position, []

    events: list[LifecycleEvent] = []
    working = replace(position, last_price=price, updated_at=now)

    # ── waiting for the entry ────────────────────────────────────────────────
    if working.status == "PENDING_ENTRY":
        working = replace(
            working,
            pending_mfe_pct=round(
                max(
                    working.pending_mfe_pct,
                    _signed_move(snapshot.direction, snapshot.reference_entry, price),
                ),
                4,
            ),
            pending_mae_pct=round(
                min(
                    working.pending_mae_pct,
                    _signed_move(snapshot.direction, snapshot.reference_entry, price),
                ),
                4,
            ),
        )
        if _in_zone(snapshot, price):
            if working.zone_touched_at is None:
                working = replace(working, zone_touched_at=now)
                events.append(LifecycleEvent(type="ENTRY_ZONE_TOUCHED", ts=now, price=price))
            working = replace(
                working,
                status="ACTIVE",
                entered_at=now,
                entry_price=price,
                best_price=price,
                worst_price=price,
            )
            events.append(
                LifecycleEvent(
                    type="ENTRY_FILLED",
                    ts=now,
                    price=price,
                    detail={"wait_seconds": round(now - snapshot.detected_at, 2)},
                )
            )
            return working, events

        if now - snapshot.detected_at >= config.entry_window_seconds:
            # Never tradable. Deliberately *not* a loss.
            events.append(
                LifecycleEvent(
                    type="EXPIRED",
                    ts=now,
                    price=price,
                    detail={
                        "reason": "no_fill",
                        "touched_zone": working.zone_touched_at is not None,
                    },
                )
            )
            return (
                replace(
                    working,
                    status="NO_FILL",
                    settled_at=now,
                    exit_price=price,
                    exit_reason="no_fill",
                    realized_r=0.0,
                ),
                events,
            )
        return working, events

    # ── in the trade ─────────────────────────────────────────────────────────
    entry = working.entry_price if working.entry_price is not None else snapshot.reference_entry
    move_pct = _signed_move(snapshot.direction, entry, price)
    r_now = _r_multiple(snapshot, entry, price)

    better = (
        price > (working.best_price or price)
        if snapshot.direction == "bullish"
        else price < (working.best_price or price)
    )
    worse = (
        price < (working.worst_price or price)
        if snapshot.direction == "bullish"
        else price > (working.worst_price or price)
    )
    working = replace(
        working,
        best_price=price if better or working.best_price is None else working.best_price,
        worst_price=price if worse or working.worst_price is None else working.worst_price,
        mfe_pct=round(max(working.mfe_pct, move_pct), 4),
        mae_pct=round(min(working.mae_pct, move_pct), 4),
        mfe_r=round(max(working.mfe_r, r_now), 4),
        mae_r=round(min(working.mae_r, r_now), 4),
    )

    # Trailing runs before settlement so a stop that tightened on this very
    # observation is the one that gets tested against it.
    trailed = _trail_to(snapshot, working, entry, working.best_price or price, config)
    if trailed is not None:
        first = not working.trailing_active
        working = replace(
            working,
            active_stop=trailed,
            trailing_activated_at=working.trailing_activated_at or now,
            trailing_updates=(*working.trailing_updates, (now, trailed)),
        )
        if first:
            events.append(
                LifecycleEvent(
                    type="TRAIL_ACTIVATED",
                    ts=now,
                    price=price,
                    detail={"stop": trailed, "r": round(working.mfe_r, 3)},
                )
            )
        else:
            events.append(
                LifecycleEvent(type="TRAIL_UPDATED", ts=now, price=price, detail={"stop": trailed})
            )

    # Target first, then the stop in force, then the clock. A single price
    # cannot be on both sides of the entry, so this order never has to break a
    # tie — see the module docstring.
    cost_r = cost_in_r(snapshot, entry, config)

    if _beyond_target(snapshot, price):
        # Fills at the target, not at the observation that revealed it.
        fill = snapshot.target
        gross = _r_multiple(snapshot, entry, fill)
        events.append(
            LifecycleEvent(
                type="TARGET_HIT",
                ts=now,
                price=price,
                detail={"cost_r": cost_r, "fill": fill, "observed": price},
            )
        )
        return (
            replace(
                working,
                status="TARGET_HIT",
                settled_at=now,
                exit_price=fill,
                exit_reason="target",
                gross_r=round(gross, 4),
                cost_r=round(cost_r, 4),
                realized_r=round(gross - cost_r, 4),
            ),
            events,
        )

    if _beyond_stop(snapshot, working.active_stop, price):
        trailed_out = working.trailing_active
        fill = working.active_stop
        gross = _r_multiple(snapshot, entry, fill)
        events.append(
            LifecycleEvent(
                type="INVALIDATED",
                ts=now,
                price=price,
                detail={
                    "stop": working.active_stop,
                    "trailed": trailed_out,
                    "fill": fill,
                    "observed": price,
                },
            )
        )
        return (
            replace(
                working,
                status="INVALIDATED",
                settled_at=now,
                exit_price=fill,
                exit_reason="trailing_stop" if trailed_out else "invalidation",
                gross_r=round(gross, 4),
                cost_r=round(cost_r, 4),
                realized_r=round(gross - cost_r, 4),
            ),
            events,
        )

    if working.entered_at is not None and now - working.entered_at >= config.max_holding_seconds:
        events.append(
            LifecycleEvent(type="EXPIRED", ts=now, price=price, detail={"reason": "timeout"})
        )
        return (
            replace(
                working,
                status="EXPIRED",
                settled_at=now,
                exit_price=price,
                exit_reason="timeout",
                gross_r=round(r_now, 4),
                cost_r=round(cost_r, 4),
                realized_r=round(r_now - cost_r, 4),
            ),
            events,
        )

    return working, events


# ─────────────────────────────────────────────────────────────────────────────
# Exit-rule variants
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Variant:
    """One alternative exit rule, run on the *same* setup as the primary.

    This is how an exit question gets answered without hindsight: identical
    detections, identical entries, identical price stream, different rules,
    all settled forward in the same instant. Comparing them is then a
    controlled experiment rather than a story about one symbol that would have
    done better.
    """

    name: str
    config: ForwardTestConfig
    #: True when the variant tests a different *plan* — its own stop and
    #: target — rather than only a different exit rule.
    #:
    #: Settlement is unchanged either way: a plan-varying alternative is
    #: advanced against **its own frozen snapshot**, built once at detection by
    #: the recorder, never by transforming the primary's. The invariant at the
    #: top of this module still holds — no snapshot is ever revised, there are
    #: simply two of them, each frozen at the same instant.
    varies_plan: bool = False


#: The rules under test. `primary` is the one whose result is the record's
#: headline; the rest ride alongside as evidence about the exit rule itself.
def default_variants(primary: ForwardTestConfig) -> tuple[Variant, ...]:
    """Alternatives worth measuring against `primary`.

    * `no_trail` — hold the structural stop to target. The "just let it run"
      hypothesis, stated precisely enough to be settled.
    * `wide_trail` — engage later and follow further back, so a normal
      retracement does not scratch a trade that reached 1R.
    * `structural_swing` — the same detection re-planned against slow 4H/1H
      structure (`smc.swing_plan`) and given days rather than hours to
      resolve. The question it settles: is the fast lane better used as a
      *trigger* for a structural hold than as a trade in its own right? Cost
      is `round_trip_pct / risk_pct`, so a structurally wider stop starts with
      an arithmetic advantage and has to earn the rest.
    """
    return (
        Variant("no_trail", replace(primary, trailing_mode="NONE")),
        Variant(
            "wide_trail",
            replace(primary, trailing_activation_r=1.5, trailing_distance_r=1.5),
        ),
        Variant(
            "structural_swing",
            replace(primary, entry_window_seconds=14_400.0, max_holding_seconds=259_200.0),
            varies_plan=True,
        ),
    )


@dataclass(frozen=True, slots=True)
class VariantOutcome:
    """What one alternative rule would have produced. Flat by design — it is
    written to a JSON column and read as a unit."""

    name: str
    status: Status
    realized_r: float
    gross_r: float
    cost_r: float
    mfe_r: float
    mae_r: float
    exit_reason: str
    settled_at: float | None

    @property
    def is_settled(self) -> bool:
        return self.status in SETTLED_STATUSES


#: Every lifecycle field of a paper position, in declaration order.
_POSITION_FIELDS = tuple(f.name for f in fields(PaperPosition))


def position_state(position: PaperPosition) -> dict[str, Any]:
    """The full lifecycle state of one position, JSON-safe.

    Written alongside a variant's outcome so an alternative rule that is still
    running when the process restarts can be *resumed* rather than silently
    frozen at whatever it happened to be. A summary (status, R) is not enough
    for that: resuming needs the stops, the excursions and the extremes.
    """
    state: dict[str, Any] = {name: getattr(position, name) for name in _POSITION_FIELDS}
    state["trailing_updates"] = [[ts, stop] for ts, stop in position.trailing_updates]
    return state


def position_from_state(state: Mapping[str, Any]) -> PaperPosition:
    """Rebuilds a position from `position_state`. Unknown keys are ignored and
    missing ones fall back to the field default, so a blob written by an older
    version still loads instead of taking down the recorder."""
    values = {name: state[name] for name in _POSITION_FIELDS if name in state}
    updates = values.get("trailing_updates") or ()
    values["trailing_updates"] = tuple((float(ts), float(stop)) for ts, stop in updates)
    return PaperPosition(**values)


def outcome_for(name: str, position: PaperPosition) -> VariantOutcome:
    return VariantOutcome(
        name=name,
        status=position.status,
        realized_r=position.realized_r,
        gross_r=position.gross_r,
        cost_r=position.cost_r,
        mfe_r=position.mfe_r,
        mae_r=position.mae_r,
        exit_reason=position.exit_reason,
        settled_at=position.settled_at,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Outcome metrics
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Outcome:
    """Derived, never stored twice: everything here is a function of the
    snapshot and the settled position."""

    status: Status
    realized_r: float
    mfe_pct: float
    mae_pct: float
    mfe_r: float
    mae_r: float
    time_to_entry: float | None
    time_in_trade: float | None
    time_to_settle: float | None
    exit_reason: str
    target_reached: bool
    trailing_activated: bool
    # NO_FILL only: how far it ran without us, and whether it ever came back.
    pending_excursion_pct: float
    touched_zone: bool


def outcome_of(snapshot: SetupSnapshot, position: PaperPosition) -> Outcome:
    return Outcome(
        status=position.status,
        realized_r=position.realized_r,
        mfe_pct=position.mfe_pct,
        mae_pct=position.mae_pct,
        mfe_r=position.mfe_r,
        mae_r=position.mae_r,
        time_to_entry=(
            round(position.entered_at - snapshot.detected_at, 2)
            if position.entered_at is not None
            else None
        ),
        time_in_trade=(
            round(position.settled_at - position.entered_at, 2)
            if position.settled_at is not None and position.entered_at is not None
            else None
        ),
        time_to_settle=(
            round(position.settled_at - snapshot.detected_at, 2)
            if position.settled_at is not None
            else None
        ),
        exit_reason=position.exit_reason,
        target_reached=position.status == "TARGET_HIT",
        trailing_activated=position.trailing_active,
        pending_excursion_pct=position.pending_mfe_pct,
        touched_zone=position.zone_touched_at is not None,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Aggregate research statistics
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ForwardTestStats:
    """Population statistics over recorded setups.

    Rates are computed over the honest denominators: fill rate over *every*
    recorded setup, win rate over *filled* ones only. Mixing those is the
    easiest way to make an untradable strategy look good.
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


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def compute_stats(rows: list[tuple[str, float, float, float]]) -> ForwardTestStats:
    """Aggregates `(status, realized_r, mfe_r, mae_r)` rows.

    Takes tuples rather than records so the same function serves the in-memory
    recorder and a database read model without either one importing the other.
    """
    total = len(rows)
    open_count = sum(1 for status, *_ in rows if status in OPEN_STATUSES)
    no_fill = sum(1 for status, *_ in rows if status == "NO_FILL")
    target_hit = sum(1 for status, *_ in rows if status == "TARGET_HIT")
    invalidated = sum(1 for status, *_ in rows if status == "INVALIDATED")
    expired = sum(1 for status, *_ in rows if status == "EXPIRED")
    settled = [row for row in rows if row[0] in SETTLED_STATUSES and row[0] != "NO_FILL"]
    decided = total - open_count

    returns = [row[1] for row in settled]
    wins = [value for value in returns if value > 0]
    losses = [value for value in returns if value < 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))

    # Peak-to-trough of the cumulative R curve, in detection order.
    equity = 0.0
    peak = 0.0
    drawdown = 0.0
    for value in returns:
        equity += value
        peak = max(peak, equity)
        drawdown = min(drawdown, equity - peak)

    return ForwardTestStats(
        total=total,
        open=open_count,
        filled=len(settled),
        no_fill=no_fill,
        target_hit=target_hit,
        invalidated=invalidated,
        expired=expired,
        fill_rate=round((len(settled) / decided) if decided else 0.0, 4),
        win_rate=round((len(wins) / len(settled)) if settled else 0.0, 4),
        no_fill_rate=round((no_fill / decided) if decided else 0.0, 4),
        average_r=round((sum(returns) / len(returns)) if returns else 0.0, 4),
        median_r=round(_median(returns), 4),
        # Expectancy per *recorded* setup, not per fill: a setup you could not
        # enter still cost you the opportunity.
        expectancy=round((sum(returns) / decided) if decided else 0.0, 4),
        profit_factor=round(gross_win / gross_loss, 4) if gross_loss > _EPS else 0.0,
        max_drawdown_r=round(drawdown, 4),
        total_r=round(sum(returns), 4),
        average_mfe_r=round((sum(row[2] for row in settled) / len(settled)) if settled else 0.0, 4),
        average_mae_r=round((sum(row[3] for row in settled) / len(settled)) if settled else 0.0, 4),
    )


def is_finite_plan(entry: float, invalidation: float, target: float) -> bool:
    """Rejects a degenerate plan before it is ever recorded — a zero-risk or
    zero-reward hypothesis would produce infinite R and poison every aggregate
    downstream."""
    values = (entry, invalidation, target)
    if not all(math.isfinite(value) and value > 0 for value in values):
        return False
    return abs(entry - invalidation) > _EPS and abs(target - entry) > _EPS
