"""EVENT AGGREGATOR — the layer that turns detector output into a situation.

Every other module in this plane answers one narrow question and refuses to
answer any other: the volume detector knows nothing about structure, the
pullback detector knows nothing about higher-timeframe bias, the path
calculator knows nothing about volume. This module is the only one allowed to
combine them, and its output is the only thing the UI groups by.

## The funnel

The scanner's job is compression, not detection volume:

    ~600 markets
      → durable events                      (`momentum_events`)
      → directional, structurally relevant  (here)
      → developing                          (pullback / completion)
      → a handful worth opening             (`worth_watching`, then a cap)

`worth_watching` is therefore a *rejection* function. It records why a
situation passed or failed in `reasons`, so an empty radar can be explained
rather than merely observed. An empty radar is a valid outcome — nothing here
manufactures a candidate to fill the page.

## The lifecycle

    NEW → DEVELOPING → PULLBACK → PULLBACK_COMPLETION → CONTINUATION_CANDIDATE
                            └──────────────┴──────────────┴──→ INVALID | STALE

Transitions need `min_state_seconds` of dwell and structural evidence, never a
change in relative volume alone. INVALID is the one exception that applies
immediately: a broken structure is not something to sit on for stability's
sake. Demotion out of PULLBACK_COMPLETION additionally requires the evidence to
fall back to FORMING or below — hysteresis, so a single tick of noise cannot
walk the card backwards.

## What it never does

No entry call, no direction advice, no "signal". A situation carries an
observed event, the context it happened in, what is developing, and the
structural path that *would* be in play — for a human, and later for an action
layer that does not exist yet.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Literal

from smc.context_alignment import Alignment
from smc.liquidity_targets import (
    DEFAULT_TARGET_CONFIG,
    Target,
    TargetConfig,
    detect_sweep,
    select_targets,
)
from smc.market_context import MarketContext
from smc.momentum import Candidate
from smc.momentum_events import MarketEvent, Qualification, SymbolTracker
from smc.pullback import ImpulseLeg, PullbackRead, read_pullback
from smc.pullback_completion import CompletionRead, read_completion
from smc.scan_profiles import SCALP, Mode, ScanProfile
from smc.structural_path import StructuralPath, build_path
from smc.structure_map import StructuralLevel, StructureMap

SituationState = Literal[
    "NEW",
    "DEVELOPING",
    "PULLBACK",
    "PULLBACK_COMPLETION",
    "CONTINUATION_CANDIDATE",
    "INVALID",
    "STALE",
]

#: Ranking priority — how far along the lifecycle a situation is. Sections are
#: ranked independently, so this only orders the combined "everything" view.
STATE_PRIORITY: dict[str, int] = {
    "PULLBACK_COMPLETION": 5,
    "CONTINUATION_CANDIDATE": 4,
    "PULLBACK": 3,
    "DEVELOPING": 2,
    "NEW": 1,
    "STALE": 0,
    "INVALID": 0,
}

#: States whose surfacing additionally requires a workable structural path.
PATH_GATED: frozenset[str] = frozenset({"PULLBACK_COMPLETION", "CONTINUATION_CANDIDATE"})

#: Evidence tiers, weakest first — used to compare against a profile's floor.
TIER_ORDER: dict[str, int] = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3}

_EPS = 1e-9


@dataclass(frozen=True, slots=True)
class Situation:
    """One symbol's compressed state, in one mode.

    Every field is either a measurement or a named read from a module that
    produced it — nothing here is synthesized prose, and every component can be
    inspected on its own.
    """

    symbol: str
    mode: Mode
    state: SituationState
    direction: str | None
    # Smoothed event score, carried from the durable event layer.
    score: float
    headline: MarketEvent | None
    # What relationship the live events form, and how strong it is.
    qualification: Qualification
    context: MarketContext | None
    alignment: Alignment

    pullback: PullbackRead | None
    completion: CompletionRead | None
    targets: tuple[Target, ...]
    path: StructuralPath | None

    worth_watching: bool
    # Why it passed or failed the funnel — codes, not sentences.
    reasons: tuple[str, ...]

    first_seen: float
    state_since: float
    updated_at: float
    # When the current retracement began, for duration and for the journal.
    pullback_started_at: float | None = None

    @property
    def is_terminal(self) -> bool:
        return self.state in ("INVALID", "STALE")

    @property
    def tier(self) -> str:
        return self.qualification.tier

    @property
    def combo(self) -> str:
        return self.qualification.combo

    @property
    def families(self) -> tuple[str, ...]:
        return self.qualification.families


def leg_from(candidate: Candidate) -> ImpulseLeg:
    """The impulse the flow machine has been tracking, in the pullback
    detector's own vocabulary. The two modules stay independent; this is the
    seam between them."""
    return ImpulseLeg(
        direction=candidate.direction,
        origin=candidate.impulse_origin,
        extreme=candidate.impulse_extreme,
        started_at=candidate.detected_at,
    )


def _levels_for(
    maps: tuple[StructureMap, ...], direction: str
) -> tuple[StructuralLevel, ...]:
    """Levels a retracement could be reaching into: above for a bearish leg,
    below for a bullish one."""
    out: list[StructuralLevel] = []
    for structure_map in maps:
        out.extend(structure_map.highs if direction == "bearish" else structure_map.lows)
    return tuple(out)


def _has_event(tracker: SymbolTracker, types: frozenset[str], since: float) -> bool:
    return any(event.type in types and event.ts >= since for event in tracker.timeline)


_CONTINUATION_TYPES: frozenset[str] = frozenset({"CONTINUATION", "STRUCTURE_BREAK"})


def _next_state(
    previous: Situation | None,
    tracker: SymbolTracker,
    pullback: PullbackRead | None,
    completion: CompletionRead | None,
    resumed: bool,
    now: float,
    profile: ScanProfile,
) -> SituationState:
    """The lifecycle, in precedence order. Pure, and deterministic given the
    same reads — the property the journal depends on."""
    current: SituationState = previous.state if previous is not None else "NEW"
    since = previous.state_since if previous is not None else now
    dwell_ok = now - since >= profile.situation.min_state_seconds

    # Structural failure applies immediately: stability is not a reason to keep
    # showing a thesis whose base has gone.
    if tracker.state == "FADED" or (pullback is not None and pullback.state == "BROKEN"):
        return "INVALID"
    if current == "INVALID":
        return "INVALID"

    # Nothing live for long enough: the event stops being news.
    if not tracker.events and now - tracker.last_active_ts >= profile.situation.stale_seconds:
        return "STALE"

    # Ageing is not development. A card whose newest event has gone quiet drops
    # out unless a *structural* event is actively extending the story — the one
    # thing that means the situation is still going somewhere. Cards already
    # into the pullback lifecycle are exempt: they are being carried by
    # structure, not by event freshness.
    if current in ("NEW", "DEVELOPING"):
        age = now - tracker.newest_event_ts
        structural_age = now - tracker.newest_structural_ts()
        extended = structural_age <= profile.situation.structural_extension_seconds
        if age >= profile.situation.developing_max_age_seconds and not extended:
            return "STALE"

    if not dwell_ok:
        return current

    if resumed and current in ("PULLBACK", "PULLBACK_COMPLETION", "CONTINUATION_CANDIDATE"):
        return "CONTINUATION_CANDIDATE"
    if completion is not None and completion.state == "LIKELY":
        return "PULLBACK_COMPLETION"
    if current == "PULLBACK_COMPLETION":
        # Hysteresis: only walk back once the evidence has genuinely collapsed,
        # not on the first tick that drops below the LIKELY bar.
        if completion is not None and completion.state in ("NONE", "FORMING"):
            return "PULLBACK" if pullback is not None and pullback.is_active else "DEVELOPING"
        return "PULLBACK_COMPLETION"
    if pullback is not None and pullback.is_active:
        return "PULLBACK"
    # Only a qualified relationship between independent families is allowed to
    # read as "developing"; a lone observation stays NEW until it either earns
    # corroboration or goes stale.
    if tracker.state in ("DEVELOPING", "CONFIRMED") and tracker.qualification.qualified:
        return "DEVELOPING"
    return "NEW"


def _assess(
    state: SituationState,
    tracker: SymbolTracker,
    headline: MarketEvent | None,
    alignment: Alignment,
    maps: tuple[StructureMap, ...],
    path: StructuralPath | None,
    now: float,
    profile: ScanProfile,
) -> tuple[bool, tuple[str, ...]]:
    """The funnel's rejection function.

    Returns whether the situation is worth surfacing and the codes behind that
    call. Every check must *reduce* the candidate set: a check that never
    rejects anything has no business being here.
    """
    reasons: list[str] = []
    if state in ("INVALID", "STALE"):
        return False, ("terminal_state",)

    qualification = tracker.qualification
    if not qualification.qualified:
        # The single most important rejection: observations are not situations.
        reasons.append("unqualified")
    elif TIER_ORDER.get(qualification.tier, 0) < TIER_ORDER.get(profile.situation.min_tier, 2):
        reasons.append("weak_evidence")
    if tracker.display_score < profile.situation.min_score:
        reasons.append("score_below_floor")
    if headline is None:
        reasons.append("no_event")
    elif now - tracker.newest_event_ts > profile.situation.freshness_seconds:
        # Freshness is measured against the newest event on the symbol: an old
        # story that keeps producing is alive, an old story that stopped is not.
        reasons.append("event_stale")
    if not maps:
        reasons.append("no_structure")
    if alignment.level == "UNKNOWN":
        reasons.append("context_unknown")
    if state in PATH_GATED and profile.situation.require_path:
        if path is None:
            reasons.append("no_structural_path")
        elif path.verdict == "SKIP":
            reasons.append("path_too_short")

    if reasons:
        return False, tuple(reasons)
    passed = [qualification.combo, f"tier_{qualification.tier.lower()}", "structurally_relevant"]
    if path is not None:
        passed.append(f"path_{path.verdict.lower()}")
    if alignment.classification != "unclassified":
        passed.append(alignment.classification)
    return True, tuple(passed)


def advance_situation(
    previous: Situation | None,
    tracker: SymbolTracker,
    candidate: Candidate | None,
    *,
    price: float,
    pullback_extreme: float | None,
    volume_ratio: float | None,
    opposing_move_pct: float,
    directional_move_pct: float,
    directional_rvol: float | None,
    micro_choch: bool,
    volatility_pct: float | None = None,
    maps: tuple[StructureMap, ...] = (),
    now: float = 0.0,
    profile: ScanProfile = SCALP,
    targets_config: TargetConfig = DEFAULT_TARGET_CONFIG,
) -> Situation:
    """Combines every detector's output into one situation. Pure.

    The caller supplies already-measured flow (`volume_ratio`,
    `directional_move_pct`, …) rather than raw metrics, so this function cannot
    quietly become a detector of its own — it only composes.
    """
    direction = tracker.direction
    pullback: PullbackRead | None = None
    completion: CompletionRead | None = None
    targets: tuple[Target, ...] = ()
    path: StructuralPath | None = None
    swept = None
    started_at = previous.pullback_started_at if previous is not None else None

    if candidate is not None and direction is not None:
        leg = leg_from(candidate)
        extreme = pullback_extreme if pullback_extreme is not None else candidate.pullback_extreme
        pullback = read_pullback(
            leg,
            price,
            pullback_extreme=extreme,
            now=now,
            started_at=started_at,
            volume_ratio=volume_ratio,
            opposing_move_pct=opposing_move_pct,
            levels=_levels_for(maps, direction),
            config=profile.pullback,
        )
        if pullback.is_active and started_at is None:
            started_at = now
            pullback = replace(pullback, duration_seconds=0.0)
        elif not pullback.is_active and pullback.state != "BROKEN":
            started_at = None

        swept = detect_sweep(maps, direction, extreme, price)
        if pullback.is_active:
            completion = read_completion(
                pullback,
                directional_move_pct=directional_move_pct,
                directional_rvol=directional_rvol,
                micro_choch=micro_choch,
                liquidity_swept=swept is not None,
                config=profile.completion,
            )

        targets = select_targets(maps, direction, price, targets_config)
        if targets:
            path = build_path(
                direction,
                entry=price,
                pullback_extreme=extreme,
                leg_size=leg.size,
                target=targets[0].price,
                target_kind=targets[0].kind,
                config=profile.path,
                # The stop has to clear this symbol's own noise band; see
                # `structural_path` on why a tighter one inflates R.
                volatility_pct=volatility_pct,
            )

    resumed = _has_event(tracker, _CONTINUATION_TYPES, started_at or 0.0) and started_at is not None
    state = _next_state(previous, tracker, pullback, completion, resumed, now, profile)

    # Once the retracement resolves, the live reads go quiet — but the evidence
    # that promoted the card is *why* it says PULLBACK_COMPLETION, so it has to
    # outlive the condition that produced it. Same reasoning as an event
    # outliving its metric.
    if previous is not None and state in ("PULLBACK_COMPLETION", "CONTINUATION_CANDIDATE"):
        if completion is None:
            completion = previous.completion
        if pullback is None or pullback.state == "NONE":
            pullback = previous.pullback
    headline = tracker.headline(now)
    worth, reasons = _assess(
        state, tracker, headline, tracker.alignment, maps, path, now, profile
    )

    first_seen = previous.first_seen if previous is not None else now
    state_since = (
        previous.state_since if previous is not None and previous.state == state else now
    )
    return Situation(
        symbol=tracker.symbol,
        mode=profile.mode,
        state=state,
        direction=direction,
        score=tracker.display_score,
        headline=headline,
        qualification=tracker.qualification,
        context=tracker.context,
        alignment=tracker.alignment,
        pullback=pullback,
        completion=completion,
        targets=targets,
        path=path,
        worth_watching=worth,
        reasons=reasons,
        first_seen=first_seen,
        state_since=state_since,
        updated_at=now,
        pullback_started_at=started_at,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Ranking
# ─────────────────────────────────────────────────────────────────────────────


def rank_key(situation: Situation, bucket: float = 5.0) -> tuple[int, int, float, str]:
    """Lifecycle stage first, then a *bucketed* score, then age.

    Bucketing is what keeps the page still: two situations a fraction of a
    point apart never trade places, and inside a bucket the tiebreak is a value
    that cannot move.
    """
    return (
        -STATE_PRIORITY.get(situation.state, 0),
        -math.floor(situation.score / bucket),
        situation.first_seen,
        situation.symbol,
    )


def rank_situations(situations: list[Situation], bucket: float = 5.0) -> list[Situation]:
    return sorted(situations, key=lambda s: rank_key(s, bucket))


def surfaced(situations: list[Situation], profile: ScanProfile = SCALP) -> list[Situation]:
    """The funnel's last stage: only what is worth watching, capped.

    Deliberately returns an empty list when nothing qualifies. "No significant
    events detected" is information; a page of marginal candidates is not.
    """
    kept = [s for s in situations if s.worth_watching]
    return rank_situations(kept)[: profile.situation.max_surfaced]
