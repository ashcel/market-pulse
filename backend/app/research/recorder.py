"""FORWARD-TEST RECORDER — captures confirmed setups and settles them live.

The plane, end to end:

    market data → detection engine → confirmed setup
                                          ↓
                                   forward-test recorder   (this module)
                                          ↓
                                   paper position state    (`smc.forward_test`)
                                          ↓
                                   settlement engine
                                          ↓
                                   forward-test results    (`repo.py`)

The arrow only points one way. This module imports the scanner; the scanner
does not know it exists, has no reference to it, and cannot be influenced by
anything recorded here. That is the point of §10: an outcome must never be able
to reach back and change a detection.

## What gets captured

A situation that is `worth_watching`, sits in a path-gated state
(PULLBACK_COMPLETION / CONTINUATION_CANDIDATE), and carries a workable
structural path. Those are the setups that actually have a plan — an entry, an
invalidation and a target — which is the minimum a forward test can settle.
**Every** qualifying setup is recorded, including the ones that look bad.

## Deduplication

Identity is `(mode, symbol, first_seen)` — the situation's own identity, not
the poll. A symbol that stays confirmed across a hundred ticks produces one
row and a lifecycle; a genuinely new setup after the old one ended produces a
new row because `first_seen` moved.

## Speed and the hot path

Settlement runs in memory on the recorder's own timer, reading the last price
from the in-memory store. The database sees a write only when something
actually changed state: an open, a transition, or a settlement. No ticks.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import replace
from datetime import datetime

from smc.arms import (
    ARMS_VERSION,
    arm_flag_values,
    settlement_variants,
    widened_plan,
)
from smc.forward_test import (
    DEFAULT_FORWARD_TEST_CONFIG,
    FORWARD_TEST_VERSION,
    OPEN_STATUSES,
    ForwardTestConfig,
    LifecycleEvent,
    PaperPosition,
    SetupSnapshot,
    advance_position,
    entry_zone,
    is_finite_plan,
    open_position,
    outcome_for,
    position_from_state,
    position_state,
    unrealized_r,
)
from smc.market_context import MARKET_CONTEXT_VERSION
from smc.market_regime import MarketRegime
from smc.momentum import MOMENTUM_VERSION
from smc.momentum_events import MOMENTUM_EVENTS_VERSION
from smc.scan_profiles import profile_for, profile_hash
from smc.situation import PATH_GATED, Situation
from smc.swing_plan import swing_plan
from smc.version import ENGINE_VERSION, config_hash, git_sha

from app.database import SessionFactory
from app.momentum import config as momentum_cfg
from app.momentum.scanner import MomentumScanner, get_scanner
from app.research import repo
from app.research.symbol_facts import ONBOARD_MAP, keep_fresh

logger = logging.getLogger("research.recorder")

#: The slow lane the `structural_swing` variant re-plans against. Taken from
#: the SWING profile so its geometry and patience come from one place, whatever
#: mode did the detecting.
_SWING_PROFILE = profile_for("SWING")
_SWING_TIMEFRAMES = _SWING_PROFILE.structure_timeframes

#: Bumped when the *recording rules* change (entry model, settlement,
#: trailing) — separately from the detector's own versions, so a dataset can
#: always be traced to both.
STRATEGY_VERSION = f"discover-forward-test/{FORWARD_TEST_VERSION}"

#: Detector generation. Bumped when a change alters what a recorded result
#: *means*, so cohorts are never pooled:
#:
#:   1 — original geometry (stops inside the noise band)
#:   2 — volatility-floored stops
#:   3 — costs deducted from realized R, per-horizon patience, SWING added
#:   4 — one live hypothesis per symbol: a second setup on a symbol already
#:       being observed is no longer recorded while the first is open (same
#:       mode at all, any mode when the direction is opposite). Generation 3
#:       recorded them, so its rows contain overlapping and sometimes
#:       contradictory positions on one move — they are not an independent
#:       sample and must not be pooled with these.
#:   5 — two measurement fixes and one geometry fix, none of them tuned on an
#:       outcome:
#:         * exits fill at the resting order's price (stop or target) instead
#:           of at the observation that revealed the crossing. Generation 4
#:           charged its stops a mean 0.174R of sampling-rate slippage and
#:           credited its targets 2.97R of overshoot — a bias whose size was
#:           set by how often the recorder looked, not by the strategy.
#:         * the stop's floor is enforced against the entry rather than the
#:           pullback extreme, so risk can no longer land under the mode's own
#:           floor (11 of 90 generation-4 rows did).
#:         * a cost floor: the round trip may eat at most `max_cost_r` of risk.
#:           Generation 4's gross edge was +17.2R and its fee bill 21.4R.
#:       Its R is therefore not comparable with generation 4's on either side.
#:   6 — cost priced per leg. The entry is a resting limit order and pays a
#:       maker's fee with a maker's slippage; a target exit is the same on the
#:       other side; a stop, trail or timeout crosses the spread and pays a
#:       taker's. Generation 5 charged both legs as takers, which over its 244
#:       costed rows overstated cost by 0.063R/trade against a gross edge of
#:       +0.107R — roughly a third of the reported deficit was the pricing,
#:       not the strategy. **Gross R is untouched**, which is why every arm
#:       gate in `smc.arms` is written against gross and none of them restart
#:       here; only `realized_r` and `cost_r` break comparability with
#:       generation 5.
DETECTOR_GENERATION = 6


def setup_key(situation: Situation) -> str:
    """Stable identity for one hypothesis. `first_seen` is part of it so a
    later, genuinely separate setup on the same symbol gets its own row."""
    return f"{situation.mode}:{situation.symbol}:{int(situation.first_seen)}"


def is_capturable(situation: Situation) -> bool:
    """Whether a situation is a forward-testable hypothesis.

    Requires a plan, not just interest: a card with no structural path has
    nothing to settle against, and recording it would only add rows that can
    never resolve.
    """
    if not situation.worth_watching or situation.direction is None:
        return False
    if situation.state not in PATH_GATED:
        return False
    path = situation.path
    if path is None or path.verdict == "SKIP":
        return False
    return is_finite_plan(path.entry, path.invalidation, path.target)


def snapshot_from(
    situation: Situation,
    now: float,
    config: ForwardTestConfig = DEFAULT_FORWARD_TEST_CONFIG,
) -> SetupSnapshot | None:
    """Freezes everything known at detection into the immutable hypothesis.

    Reads are all from the situation as it stands *now*; nothing is fetched,
    recomputed or looked up, because anything that required another round trip
    would be a value from a later instant than the detection it claims to
    describe.
    """
    path = situation.path
    if path is None or situation.direction is None:
        return None

    low, high = entry_zone(situation.direction, path.entry, path.invalidation, config)  # type: ignore[arg-type]
    pullback = situation.pullback
    completion = situation.completion
    context = situation.context
    headline = situation.headline

    return SetupSnapshot(
        symbol=situation.symbol,
        market="perp",
        mode=situation.mode,
        direction=situation.direction,  # type: ignore[arg-type]
        detected_at=now,
        state=situation.state,
        tier=situation.tier,
        combo=situation.combo,
        families=tuple(situation.families),
        score=situation.score,
        entry_low=low,
        entry_high=high,
        reference_entry=path.entry,
        initial_invalidation=path.invalidation,
        target=path.target,
        target_kind=path.target_kind,
        potential_rr=path.rr,
        htf_bias=context.bias if context is not None else "unknown",
        htf_agreement=context.agreement if context is not None else 0.0,
        alignment=situation.alignment.classification,
        alignment_level=situation.alignment.level,
        structure_trend=(
            context.reads[0].trend if context is not None and context.reads else "range"
        ),
        headline_event=headline.type if headline is not None else "",
        event_age_seconds=round(now - headline.ts, 2) if headline is not None else 0.0,
        rvol=None,
        change_1m_pct=None,
        change_3m_pct=None,
        change_5m_pct=None,
        change_15m_pct=None,
        retrace_frac=pullback.retrace_frac if pullback is not None else None,
        pullback_volume_ratio=pullback.volume_ratio if pullback is not None else None,
        completion_evidence=(
            tuple(item.code for item in completion.met) if completion is not None else ()
        ),
        micro_choch=(
            any(item.code == "MICRO_CHOCH" for item in completion.met)
            if completion is not None
            else False
        ),
        liquidity_target=bool(situation.targets) and situation.targets[0].level.is_liquidity,
        engine_version=ENGINE_VERSION,
        momentum_version=MOMENTUM_VERSION,
        events_version=MOMENTUM_EVENTS_VERSION,
        context_version=MARKET_CONTEXT_VERSION,
        forward_test_version=FORWARD_TEST_VERSION,
        config_hash=config_hash(),
        git_sha=git_sha(),
    )


def with_flow(
    snapshot: SetupSnapshot,
    telemetry: object,
    structural: object = None,
    regime: MarketRegime | None = None,
) -> SetupSnapshot:
    """Attaches the price/volume windows, the slow structural backing, and the
    whole-market regime read at the same instant.

    Called exactly once, before the snapshot is ever stored — this is part of
    *building* the hypothesis, not revising it. It exists separately only
    because the flow lives on the scanner's metrics rather than on the
    situation.
    """
    return replace(
        snapshot,
        structural_state=str(getattr(structural, "state", "") or ""),
        structural_score=float(getattr(structural, "score", 0.0) or 0.0),
        regime=regime.state if regime is not None else "unknown",
        regime_breadth=regime.breadth if regime is not None else 0.0,
        regime_energy_pct=regime.energy_pct if regime is not None else 0.0,
        regime_sample=regime.sample if regime is not None else 0,
        rvol=getattr(telemetry, "rvol_3m", None) or getattr(telemetry, "rvol_1m", None),
        change_1m_pct=getattr(telemetry, "change_1m_pct", None),
        change_3m_pct=getattr(telemetry, "change_3m_pct", None),
        change_5m_pct=getattr(telemetry, "change_5m_pct", None),
        change_15m_pct=getattr(telemetry, "change_15m_pct", None),
        # What kind of instrument this was. Same ticker frame as the windows
        # above, plus one dict lookup — no fetch, so no lookahead.
        quote_volume_24h=float(getattr(telemetry, "quote_volume_24h", 0.0) or 0.0),
        change_24h_pct=float(getattr(telemetry, "change_24h_pct", 0.0) or 0.0),
        trades_1m=float(getattr(telemetry, "trades_1m", 0.0) or 0.0),
        volatility_1m_pct=getattr(telemetry, "volatility_1m_pct", None),
        listing_age_days=ONBOARD_MAP.age_days(snapshot.symbol, snapshot.detected_at),
    )


def setup_values(snapshot: SetupSnapshot, position: PaperPosition, key: str) -> dict[str, object]:
    """The insert payload. Detection-time columns appear only here — never in
    an update."""
    return {
        "setup_key": key,
        "symbol": snapshot.symbol,
        "market": snapshot.market,
        "mode": snapshot.mode,
        "direction": snapshot.direction,
        "status": position.status,
        "detected_at": repo.to_utc(snapshot.detected_at),
        "state": snapshot.state,
        "tier": snapshot.tier,
        "combo": snapshot.combo,
        "score": snapshot.score,
        "families": list(snapshot.families),
        "entry_low": snapshot.entry_low,
        "entry_high": snapshot.entry_high,
        "reference_entry": snapshot.reference_entry,
        "initial_invalidation": snapshot.initial_invalidation,
        "target": snapshot.target,
        "target_kind": snapshot.target_kind,
        "potential_rr": snapshot.potential_rr,
        "htf_bias": snapshot.htf_bias,
        "htf_agreement": snapshot.htf_agreement,
        "alignment": snapshot.alignment,
        "alignment_level": snapshot.alignment_level,
        "structure_trend": snapshot.structure_trend,
        "regime": snapshot.regime,
        "evidence": {
            "headline_event": snapshot.headline_event,
            "event_age_seconds": snapshot.event_age_seconds,
            "rvol": snapshot.rvol,
            "change_1m_pct": snapshot.change_1m_pct,
            "change_3m_pct": snapshot.change_3m_pct,
            "change_5m_pct": snapshot.change_5m_pct,
            "change_15m_pct": snapshot.change_15m_pct,
            "retrace_frac": snapshot.retrace_frac,
            "pullback_volume_ratio": snapshot.pullback_volume_ratio,
            "completion_evidence": list(snapshot.completion_evidence),
            "micro_choch": snapshot.micro_choch,
            "liquidity_target": snapshot.liquidity_target,
            # Slow structural backing, for later segmentation. Never a gate.
            "structural_state": snapshot.structural_state,
            "structural_score": snapshot.structural_score,
            # The numbers the `regime` column's label came from, so a later
            # analysis can re-cut the threshold without replaying the tape.
            "regime_breadth": snapshot.regime_breadth,
            "regime_energy_pct": snapshot.regime_energy_pct,
            "regime_sample": snapshot.regime_sample,
            # The instrument, as distinct from the setup. `stop_noise_ratio` is
            # derived from fields on this same row rather than measured, and is
            # written out only so a SQL cut does not have to recompute it.
            "quote_volume_24h": snapshot.quote_volume_24h,
            "change_24h_pct": snapshot.change_24h_pct,
            "trades_1m": snapshot.trades_1m,
            "volatility_1m_pct": snapshot.volatility_1m_pct,
            "listing_age_days": snapshot.listing_age_days,
            "stop_noise_ratio": snapshot.stop_noise_ratio,
        },
        "strategy_version": STRATEGY_VERSION,
        # The exact detector configuration, so revisions never pool.
        "config_hash": profile_hash(profile_for(snapshot.mode)),
        "engine_version": snapshot.engine_version,
        "git_sha": snapshot.git_sha,
        "versions": {
            "generation": DETECTOR_GENERATION,
            "engine_config_hash": snapshot.config_hash,
            "momentum": snapshot.momentum_version,
            "events": snapshot.events_version,
            "context": snapshot.context_version,
            "forward_test": snapshot.forward_test_version,
            "arms": ARMS_VERSION,
        },
        # Which detector arms would have taken this setup. Frozen at detection
        # like everything else on this row, and read only by the weekly report
        # — the live detector never consults it.
        "arm_flags": arm_flag_values(snapshot),
        "active_stop": position.active_stop,
        "trailing_mode": position.trailing_mode,
        "last_price": position.last_price,
        "updated_at": repo.to_utc(position.updated_at),
    }


def _variant_config(primary: ForwardTestConfig, name: str) -> ForwardTestConfig:
    for variant in settlement_variants(primary):
        if variant.name == name:
            return variant.config
    return primary


#: The detection-time plan fields a plan-varying alternative overrides. Only
#: these: an alternative is the *same* observation of the *same* symbol at the
#: *same* instant, differing solely in the geometry laid over it.
_PLAN_FIELDS = (
    "entry_low",
    "entry_high",
    "reference_entry",
    "initial_invalidation",
    "target",
    "target_kind",
    "potential_rr",
)


def plan_values(snapshot: SetupSnapshot) -> dict[str, object]:
    """The overridden plan, JSON-safe, for the `variants` column."""
    return {name: getattr(snapshot, name) for name in _PLAN_FIELDS}


def variant_values(
    variants: dict[str, PaperPosition],
    plans: dict[str, SetupSnapshot] | None = None,
) -> dict[str, object] | None:
    """The `variants` column: one outcome per alternative rule, each carrying
    its full lifecycle state so an alternative still running after a restart
    resumes instead of freezing at whatever it last happened to be.

    A plan-varying alternative also carries the plan itself. Without it a
    resumed swing variant would be settled against the *fast* stop and target,
    which would not merely be inaccurate — it would silently answer a
    different question than the one the column exists to ask.
    """
    if not variants:
        return None
    plans = plans or {}
    blobs: dict[str, object] = {}
    for name, alt in variants.items():
        blob: dict[str, object] = {
            "status": outcome_for(name, alt).status,
            "realized_r": alt.realized_r,
            "gross_r": alt.gross_r,
            "cost_r": alt.cost_r,
            "mfe_r": alt.mfe_r,
            "mae_r": alt.mae_r,
            "exit_reason": alt.exit_reason,
            "settled_at": alt.settled_at,
            "state": position_state(alt),
        }
        if name in plans:
            blob["plan"] = plan_values(plans[name])
        blobs[name] = blob
    return blobs


def variants_from_row(row: object) -> dict[str, PaperPosition]:
    """Rebuilds the alternative positions from the stored column. A blob
    written before variant state was persisted has no `state` and is dropped
    rather than resumed from a summary — a wrong resume would corrupt the
    comparison the column exists for."""
    stored = getattr(row, "variants", None) or {}
    rebuilt: dict[str, PaperPosition] = {}
    for name, blob in stored.items():
        state = blob.get("state") if isinstance(blob, dict) else None
        if not state:
            continue
        try:
            rebuilt[name] = position_from_state(state)
        except (TypeError, ValueError):
            logger.warning("[forward-test] unreadable variant state for %s", name)
    return rebuilt


def variant_plans_from_row(row: object, primary: SetupSnapshot) -> dict[str, SetupSnapshot]:
    """Rebuilds each plan-varying alternative's frozen hypothesis.

    A restore, not a revision: every value here was written at detection and is
    read straight back. Alternatives without a stored plan are absent, and the
    caller then settles them against the primary — which is correct, because
    those are the ones that only ever varied the exit rule.
    """
    stored = getattr(row, "variants", None) or {}
    rebuilt: dict[str, SetupSnapshot] = {}
    for name, blob in stored.items():
        plan = blob.get("plan") if isinstance(blob, dict) else None
        if not plan:
            continue
        try:
            rebuilt[name] = replace(primary, **{k: plan[k] for k in _PLAN_FIELDS})
        except (KeyError, TypeError, ValueError):
            logger.warning("[forward-test] unreadable variant plan for %s", name)
    return rebuilt


def lifecycle_values(
    position: PaperPosition,
    event_count: int,
    variants: dict[str, PaperPosition] | None = None,
    regime: MarketRegime | None = None,
    plans: dict[str, SetupSnapshot] | None = None,
) -> dict[str, object]:
    """The update payload — lifecycle and outcome only.

    `variants` is omitted rather than nulled when there is nothing to write, so
    a pass that has no alternatives in memory cannot erase the ones already on
    the row.

    `exit_regime` is written only on the pass that settles the position. Writing
    it on every update would leave the last mark before settlement, which is the
    same value nine times out of ten and a lie the tenth.
    """
    alternatives = variant_values(variants or {}, plans or {})
    values: dict[str, object] = {
        "gross_r": position.gross_r,
        "cost_r": position.cost_r,
        "status": position.status,
        "zone_touched_at": repo.to_utc(position.zone_touched_at),
        "entered_at": repo.to_utc(position.entered_at),
        "entry_price": position.entry_price,
        "active_stop": position.active_stop,
        "trailing_activated_at": repo.to_utc(position.trailing_activated_at),
        "trailing_updates": [[ts, stop] for ts, stop in position.trailing_updates],
        "settled_at": repo.to_utc(position.settled_at),
        "exit_price": position.exit_price,
        "exit_reason": position.exit_reason,
        "realized_r": position.realized_r,
        "mfe_pct": position.mfe_pct,
        "mae_pct": position.mae_pct,
        "mfe_r": position.mfe_r,
        "mae_r": position.mae_r,
        "pending_mfe_pct": position.pending_mfe_pct,
        "pending_mae_pct": position.pending_mae_pct,
        "touched_zone": position.zone_touched_at is not None,
        "event_count": event_count,
        "last_price": position.last_price,
        "updated_at": repo.to_utc(position.updated_at),
    }
    if alternatives is not None:
        values["variants"] = alternatives
    if position.is_settled and regime is not None:
        values["exit_regime"] = regime.state
    return values


def snapshot_from_row(row: object) -> SetupSnapshot:
    """Rebuilds the frozen hypothesis from its persisted columns.

    This is a *read*, not a recomputation: every field comes back from what was
    written at detection. Nothing is re-derived from current market data, which
    is what keeps a resumed record as lookahead-free as one that never
    restarted.
    """
    evidence = row.evidence or {}  # type: ignore[attr-defined]
    versions = row.versions or {}  # type: ignore[attr-defined]
    return SetupSnapshot(
        symbol=row.symbol,  # type: ignore[attr-defined]
        market=row.market,  # type: ignore[attr-defined]
        mode=row.mode,  # type: ignore[attr-defined]
        direction=row.direction,  # type: ignore[attr-defined]
        detected_at=repo.from_utc(row.detected_at) or 0.0,  # type: ignore[attr-defined]
        state=row.state,  # type: ignore[attr-defined]
        tier=row.tier,  # type: ignore[attr-defined]
        combo=row.combo,  # type: ignore[attr-defined]
        families=tuple(row.families or []),  # type: ignore[attr-defined]
        score=row.score,  # type: ignore[attr-defined]
        entry_low=row.entry_low,  # type: ignore[attr-defined]
        entry_high=row.entry_high,  # type: ignore[attr-defined]
        reference_entry=row.reference_entry,  # type: ignore[attr-defined]
        initial_invalidation=row.initial_invalidation,  # type: ignore[attr-defined]
        target=row.target,  # type: ignore[attr-defined]
        target_kind=row.target_kind,  # type: ignore[attr-defined]
        potential_rr=row.potential_rr,  # type: ignore[attr-defined]
        htf_bias=row.htf_bias,  # type: ignore[attr-defined]
        htf_agreement=row.htf_agreement,  # type: ignore[attr-defined]
        alignment=row.alignment,  # type: ignore[attr-defined]
        alignment_level=row.alignment_level,  # type: ignore[attr-defined]
        structure_trend=row.structure_trend,  # type: ignore[attr-defined]
        headline_event=str(evidence.get("headline_event", "")),
        event_age_seconds=float(evidence.get("event_age_seconds") or 0.0),
        rvol=evidence.get("rvol"),
        change_1m_pct=evidence.get("change_1m_pct"),
        change_3m_pct=evidence.get("change_3m_pct"),
        change_5m_pct=evidence.get("change_5m_pct"),
        change_15m_pct=evidence.get("change_15m_pct"),
        retrace_frac=evidence.get("retrace_frac"),
        pullback_volume_ratio=evidence.get("pullback_volume_ratio"),
        completion_evidence=tuple(evidence.get("completion_evidence") or []),
        micro_choch=bool(evidence.get("micro_choch")),
        liquidity_target=bool(evidence.get("liquidity_target")),
        structural_state=str(evidence.get("structural_state") or ""),
        structural_score=float(evidence.get("structural_score") or 0.0),
        regime=str(getattr(row, "regime", None) or "unknown"),
        regime_breadth=float(evidence.get("regime_breadth") or 0.0),
        regime_energy_pct=float(evidence.get("regime_energy_pct") or 0.0),
        regime_sample=int(evidence.get("regime_sample") or 0),
        # Rows written before these shipped have no key here. They stay None /
        # 0.0 rather than being back-filled from today's ticker, which would
        # stamp a later instant's fact onto an earlier detection.
        quote_volume_24h=float(evidence.get("quote_volume_24h") or 0.0),
        change_24h_pct=float(evidence.get("change_24h_pct") or 0.0),
        trades_1m=float(evidence.get("trades_1m") or 0.0),
        volatility_1m_pct=evidence.get("volatility_1m_pct"),
        listing_age_days=evidence.get("listing_age_days"),
        engine_version=row.engine_version,  # type: ignore[attr-defined]
        momentum_version=str(versions.get("momentum", "")),
        events_version=str(versions.get("events", "")),
        context_version=str(versions.get("context", "")),
        forward_test_version=str(versions.get("forward_test", "")),
        config_hash=row.config_hash,  # type: ignore[attr-defined]
        git_sha=row.git_sha,  # type: ignore[attr-defined]
    )


def position_from_row(row: object) -> PaperPosition:
    """Rebuilds a live position from its persisted lifecycle columns.

    Used when adopting a row this process did not open — after a restart, or
    when the dedup key already exists. Rebuilding rather than starting fresh is
    what stops an in-flight hypothesis silently going back to PENDING_ENTRY and
    re-living a lifecycle it already had.
    """

    def seconds(value: object) -> float | None:
        return repo.from_utc(value) if isinstance(value, datetime) else None

    return PaperPosition(
        status=row.status,  # type: ignore[attr-defined]
        zone_touched_at=seconds(row.zone_touched_at),  # type: ignore[attr-defined]
        entered_at=seconds(row.entered_at),  # type: ignore[attr-defined]
        entry_price=row.entry_price,  # type: ignore[attr-defined]
        active_stop=row.active_stop,  # type: ignore[attr-defined]
        trailing_mode=row.trailing_mode,  # type: ignore[attr-defined]
        trailing_activated_at=seconds(row.trailing_activated_at),  # type: ignore[attr-defined]
        trailing_updates=tuple(
            (float(ts), float(stop))
            for ts, stop in (row.trailing_updates or [])  # type: ignore[attr-defined]
        ),
        mfe_pct=row.mfe_pct,  # type: ignore[attr-defined]
        mae_pct=row.mae_pct,  # type: ignore[attr-defined]
        mfe_r=row.mfe_r,  # type: ignore[attr-defined]
        mae_r=row.mae_r,  # type: ignore[attr-defined]
        pending_mfe_pct=row.pending_mfe_pct,  # type: ignore[attr-defined]
        pending_mae_pct=row.pending_mae_pct,  # type: ignore[attr-defined]
        last_price=row.last_price,  # type: ignore[attr-defined]
        updated_at=seconds(row.updated_at) or 0.0,  # type: ignore[attr-defined]
    )


def event_values(setup_id: str, event: LifecycleEvent) -> dict[str, object]:
    return {
        "setup_id": setup_id,
        "type": event.type,
        "ts": repo.to_utc(event.ts),
        "price": event.price,
        "detail": dict(event.detail),
    }


class ForwardTestRecorder:
    """Captures confirmed setups, settles them against live prices, persists
    only the transitions."""

    def __init__(
        self,
        scanner: MomentumScanner | None = None,
        config: ForwardTestConfig | None = None,
    ) -> None:
        self._scanner = scanner
        # Fallback only: each capture uses its own profile's forward-test
        # config, because patience is part of the hypothesis.
        self.config = config if config is not None else DEFAULT_FORWARD_TEST_CONFIG
        # Live hypotheses, keyed by setup identity.
        self._open: dict[str, tuple[str, SetupSnapshot, PaperPosition, int]] = {}
        # Alternative exit rules running on those same hypotheses.
        self._variants: dict[str, dict[str, PaperPosition]] = {}
        # …and the frozen hypothesis each *plan-varying* alternative runs
        # against. Absent for exit-rule-only variants, which share the
        # primary's plan by definition.
        self._plans: dict[str, dict[str, SetupSnapshot]] = {}
        # Alternatives whose primary has already settled. `no_trail` outlives a
        # trailed exit by construction — dropping it there would freeze the
        # variant at the primary's exit and silently score the comparison in
        # the primary's favour, which is the opposite of what it measures.
        self._variant_only: dict[
            str, tuple[str, SetupSnapshot, dict[str, PaperPosition], dict[str, SetupSnapshot]]
        ] = {}
        # Keys whose hypothesis has already been settled. A settled record is
        # terminal: without this, a symbol that stays confirmed after its stop
        # was hit would be re-adopted on the next capture pass and start a
        # second lifecycle on the same row.
        self._closed: set[str] = set()
        # Situations a conflict kept out, so the block is counted once each.
        self._skipped: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        # The onboard-date refresh runs on its own task rather than inside the
        # tick: the fetch is the only network call anywhere near the recorder,
        # and a tick that stalls on it would delay settlement.
        self._facts_task: asyncio.Task[None] | None = None
        self._stopping = False
        self.captured = 0
        self.settled = 0
        self.ticks = 0
        # Setups a live position on the same symbol kept out of the dataset.
        self.skipped_conflicts = 0

    @property
    def scanner(self) -> MomentumScanner:
        return self._scanner if self._scanner is not None else get_scanner()

    # ── lifecycle ───────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(self._loop(), name="forward-test-recorder")
        if self._facts_task is None or self._facts_task.done():
            self._facts_task = asyncio.create_task(
                keep_fresh(), name="forward-test-symbol-facts"
            )

    async def resume(self) -> int:
        """Reloads hypotheses that were still open when the process stopped.

        Without this a restart silently orphans every in-flight record: the row
        stays OPEN forever, never settles, and quietly biases the dataset
        toward whatever happened to be closed already. Returns how many were
        picked back up.
        """
        async with SessionFactory() as db:
            rows = await repo.open_setups(db)
            trailing = await repo.settled_with_open_variants(db)
        for row in rows:
            key = row.setup_key
            if key in self._open or key in self._closed:
                continue
            primary = snapshot_from_row(row)
            self._open[key] = (
                str(row.id),
                primary,
                position_from_row(row),
                row.event_count,
            )
            variants = variants_from_row(row)
            if variants:
                self._variants[key] = variants
                plans = variant_plans_from_row(row, primary)
                if plans:
                    self._plans[key] = plans
        for row in trailing:
            key = row.setup_key
            if key in self._variant_only:
                continue
            variants = variants_from_row(row)
            if any(position.is_open for position in variants.values()):
                primary = snapshot_from_row(row)
                self._closed.add(key)
                self._variant_only[key] = (
                    str(row.id),
                    primary,
                    variants,
                    variant_plans_from_row(row, primary),
                )
        if rows or trailing:
            logger.info(
                "[forward-test] resumed %d open setup(s) and %d trailing variant set(s)",
                len(rows),
                len(self._variant_only),
            )
        return len(rows)

    async def stop(self) -> None:
        self._stopping = True
        facts = self._facts_task
        self._facts_task = None
        if facts is not None and not facts.done():
            facts.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await facts
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

    async def _loop(self) -> None:
        while not self._stopping:
            try:
                await self.tick(time.time())
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[forward-test] recorder tick failed")
            await asyncio.sleep(RECORDER_INTERVAL_SECONDS)

    # ── the tick ────────────────────────────────────────────────────────────

    async def tick(self, now: float) -> int:
        """One pass: capture new setups, settle open ones. Returns how many
        database writes it made — zero on a quiet tape, which is the common
        case and the reason this is safe to run alongside the radar."""
        writes = 0
        for mode in self.scanner.modes:
            writes += await self._capture(mode, now)
        writes += await self._settle(now)
        self.ticks += 1
        return writes

    def conflict_for(self, symbol: str, mode: str, direction: str | None) -> str | None:
        """Why a symbol already under observation blocks a new record.

        One live hypothesis per symbol, whatever the mode or direction. The
        detector's clock and the position's clock are independent — a situation
        can end, re-fire minutes later with a new `first_seen`, and mint a
        second row while the first position is still running — and the two were
        never checked against each other. That produced exactly what it sounds
        like: one price move recorded as several outcomes, and on one symbol a
        long opened while a short was still open.

        Neither is a sample. Two records on one symbol are one price series
        counted twice, and a long and a short at once cannot both be right.
        Neither is actionable either. So the first hypothesis holds the symbol
        until it settles, and every later one is counted as a rejection instead
        of a row.

        The cost is deliberate and worth naming: the mode comparison now
        happens across time rather than simultaneously, and the faster profile
        reaches a symbol first more often — so SCALP will claim contested
        symbols and INTRADAY/SWING will record fewer of them. `skipped_conflicts`
        is what keeps that visible instead of silent.
        """
        for _, snap, _, _ in self._open.values():
            if snap.symbol != symbol:
                continue
            if snap.mode == mode:
                return "same_mode_open"
            if direction is not None and snap.direction != direction:
                return "opposite_direction_open"
            return "symbol_already_open"
        return None

    def _swing_snapshot(self, frozen: SetupSnapshot) -> SetupSnapshot | None:
        """The same detection re-planned against slow 4H/1H structure.

        Reads only the structure the slow lane has already cached — no fetch,
        no recompute — so the alternative hypothesis is frozen from the same
        instant as the primary and inherits its no-lookahead guarantee.

        `None` whenever slow structure offers no plan, which is most of the
        time and is the honest answer: the fast event fired, and nothing on
        the 4H said anything about it.
        """
        cache = getattr(self.scanner, "context_cache", None)
        if cache is None:
            return None
        maps = cache.maps(frozen.symbol, _SWING_TIMEFRAMES)
        if not maps:
            return None
        path = swing_plan(
            frozen.direction,
            frozen.reference_entry,
            maps,
            config=_SWING_PROFILE.path,
        )
        if path is None or path.verdict == "SKIP":
            return None
        if not is_finite_plan(path.entry, path.invalidation, path.target):
            return None
        low, high = entry_zone(
            frozen.direction, path.entry, path.invalidation, _SWING_PROFILE.forward_test
        )
        return replace(
            frozen,
            entry_low=low,
            entry_high=high,
            reference_entry=path.entry,
            initial_invalidation=path.invalidation,
            target=path.target,
            target_kind=path.target_kind,
            potential_rr=path.rr,
        )

    def _arm_plan(
        self, name: str, frozen: SetupSnapshot, config: ForwardTestConfig
    ) -> SetupSnapshot | None:
        """The frozen hypothesis for one plan-varying arm, or `None` when the
        arm has no alternative to offer on this setup.

        Dispatch lives here rather than in `smc.arms` because `structural_swing`
        needs the scanner's slow-lane cache, which is a recorder concern; the
        registry stays free of runtime plumbing.
        """
        if name == "structural_swing":
            return self._swing_snapshot(frozen)
        if name == "wide_stop":
            return widened_plan(frozen, config)
        logger.warning("[forward-test] no plan builder for arm %s", name)
        return None

    async def _capture(self, mode: str, now: float) -> int:
        snapshot = self.scanner.snapshot(mode)
        writes = 0
        for entry in snapshot.situations:
            situation = entry.situation
            if not is_capturable(situation):
                continue
            key = setup_key(situation)
            if key in self._open or key in self._closed:
                continue
            conflict = self.conflict_for(situation.symbol, situation.mode, situation.direction)
            if conflict is not None:
                # Counted and logged once per situation, not once per tick: a
                # blocked setup stays qualified for as long as it lives, and a
                # per-tick count would read as hundreds of rejections.
                if key not in self._skipped:
                    self._skipped.add(key)
                    self.skipped_conflicts += 1
                    logger.info(
                        "[forward-test] skipped %s %s %s — %s",
                        situation.mode,
                        situation.symbol,
                        situation.direction,
                        conflict,
                    )
                continue
            frozen = snapshot_from(situation, now, profile_for(situation.mode).forward_test)
            if frozen is None:
                continue
            profile = profile_for(situation.mode)
            config = profile.forward_test
            frozen = with_flow(frozen, entry.metrics, entry.structural, self.scanner.regime)
            position, events = open_position(frozen, now, entry.metrics.price, config)
            # The same hypothesis under alternative exit rules. Identical
            # detection, identical entry, identical price stream — the only
            # honest way to compare exits.
            plans: dict[str, SetupSnapshot] = {}
            variants: dict[str, PaperPosition] = {}
            for variant in settlement_variants(config):
                hypothesis = frozen
                if variant.varies_plan:
                    alternative = self._arm_plan(variant.name, frozen, variant.config)
                    if alternative is None:
                        # This arm had nothing to say about this setup — slow
                        # structure offered no plan, or the control's stop
                        # already cleared the floor. Recording the control's
                        # own geometry under the arm's name would answer the
                        # wrong question, so the arm is simply absent here.
                        continue
                    hypothesis = alternative
                    plans[variant.name] = alternative
                variants[variant.name] = open_position(
                    hypothesis, now, entry.metrics.price, variant.config
                )[0]

            async with SessionFactory() as db:
                setup_id = await repo.insert_setup(db, setup_values(frozen, position, key))
                if setup_id is None:
                    # Already recorded by an earlier run. Adopt it rather than
                    # duplicating — but only if it is still open, and with its
                    # persisted lifecycle rather than a fresh one.
                    existing = await repo.find_row(db, key)
                    if existing is None:
                        continue
                    if existing.status not in OPEN_STATUSES:
                        self._closed.add(key)
                        continue
                    self._open[key] = (
                        str(existing.id),
                        frozen,
                        position_from_row(existing),
                        existing.event_count,
                    )
                    adopted = variants_from_row(existing)
                    # A row written before variant state was stored comes back
                    # without one. Starting its alternatives fresh here would
                    # date them from the adoption rather than the detection, so
                    # they are left off the row instead of faked.
                    if adopted:
                        self._variants[key] = adopted
                        adopted_plans = variant_plans_from_row(existing, frozen)
                        if adopted_plans:
                            self._plans[key] = adopted_plans
                    continue
                await repo.insert_events(db, [event_values(setup_id, e) for e in events])
            self._open[key] = (setup_id, frozen, position, len(events))
            self._variants[key] = variants
            if plans:
                self._plans[key] = plans
            self.captured += 1
            writes += 1
            swing = plans.get("structural_swing")
            logger.info(
                "[forward-test] captured %s %s %s @ %.6g (%.1fR) in a %s tape — swing %s",
                frozen.mode,
                frozen.symbol,
                frozen.direction,
                frozen.reference_entry,
                frozen.potential_rr,
                frozen.regime,
                (
                    f"{swing.potential_rr:.1f}R stop {swing.initial_invalidation:.6g}"
                    if swing is not None
                    else "none"
                ),
            )
        return writes

    async def _settle(self, now: float) -> int:
        """Advances every open hypothesis against the latest observed price."""
        writes = 0
        for key, (setup_id, snapshot, position, count) in list(self._open.items()):
            price = self._price_for(snapshot.symbol)
            if price is None:
                continue
            config = profile_for(snapshot.mode).forward_test
            advanced, events = advance_position(snapshot, position, price, now, config)
            # Alternatives settle on the same observation, always.
            alternatives = self._variants.get(key, {})
            plans = self._plans.get(key, {})
            for name, variant_position in list(alternatives.items()):
                moved, _ = advance_position(
                    plans.get(name, snapshot),
                    variant_position,
                    price,
                    now,
                    _variant_config(config, name),
                )
                alternatives[name] = moved
            if advanced == position and not events:
                continue

            total = count + len(events)
            self._open[key] = (setup_id, snapshot, advanced, total)
            # A write per transition, not per tick: the excursion fields drift
            # constantly, so persisting them alone would be a tick log by
            # another name.
            if events or advanced.is_settled:
                async with SessionFactory() as db:
                    await repo.update_lifecycle(
                        db,
                        setup_id,
                        lifecycle_values(advanced, total, alternatives, self.scanner.regime, plans),
                    )
                    await repo.insert_events(
                        db, [event_values(setup_id, event) for event in events]
                    )
                writes += 1
            if advanced.is_settled:
                del self._open[key]
                self._variants.pop(key, None)
                self._plans.pop(key, None)
                self._closed.add(key)
                self.settled += 1
                if any(position.is_open for position in alternatives.values()):
                    # The row is terminal; at least one alternative is not.
                    # The whole set is carried over — settled ones included, so
                    # the column is never rewritten with a subset. The swing
                    # variant is the extreme case: days of holding against a
                    # primary that resolved in minutes.
                    self._variant_only[key] = (
                        setup_id,
                        snapshot,
                        dict(alternatives),
                        dict(plans),
                    )
                logger.info(
                    "[forward-test] settled %s %s → %s (%.2fR)",
                    snapshot.mode,
                    snapshot.symbol,
                    advanced.status,
                    advanced.realized_r,
                )
        writes += await self._settle_variants(now)
        return writes

    async def _settle_variants(self, now: float) -> int:
        """Advances alternatives whose primary already exited.

        Nothing here can touch the primary's outcome: the only column written
        is `variants`, and the row's own status, exit and R are long since
        final.
        """
        writes = 0
        for key, (setup_id, snapshot, variants, plans) in list(self._variant_only.items()):
            price = self._price_for(snapshot.symbol)
            if price is None:
                continue
            config = profile_for(snapshot.mode).forward_test
            moved = {
                name: advance_position(
                    plans.get(name, snapshot), position, price, now, _variant_config(config, name)
                )[0]
                for name, position in variants.items()
            }
            if all(position == variants[name] for name, position in moved.items()):
                continue
            self._variant_only[key] = (setup_id, snapshot, moved, plans)
            if any(position.is_settled for position in moved.values()):
                async with SessionFactory() as db:
                    await repo.update_lifecycle(
                        db, setup_id, {"variants": variant_values(moved, plans)}
                    )
                writes += 1
            if all(position.is_settled for position in moved.values()):
                del self._variant_only[key]
        return writes

    def _price_for(self, symbol: str) -> float | None:
        """Latest observed price from the radar's in-memory store — the
        highest-resolution series available, and free to read."""
        state = self.scanner.store.get(symbol)
        if state is None or not state.price:
            return None
        return float(state.price[-1])

    # ── reads ───────────────────────────────────────────────────────────────

    @property
    def open_count(self) -> int:
        return len(self._open)

    def open_keys(self) -> list[str]:
        return list(self._open)

    def live_marks(self) -> dict[str, dict[str, float | None]]:
        """The current mark for every open hypothesis, keyed by setup id.

        The database only ever sees a transition — persisting the excursion
        fields every tick would be a tick log by another name — so the row an
        API read returns is correct as of the last *event*, which can be an
        hour ago on a quiet position. This is the missing half: the same
        numbers as of the last observation, straight out of memory, free to
        read and never written anywhere.
        """
        marks: dict[str, dict[str, float | None]] = {}
        for setup_id, snapshot, position, _ in self._open.values():
            config = profile_for(snapshot.mode).forward_test
            marks[setup_id] = {
                "last_price": position.last_price,
                "updated_at": position.updated_at,
                "active_stop": position.active_stop,
                "mfe_r": position.mfe_r,
                "mae_r": position.mae_r,
                "mfe_pct": position.mfe_pct,
                "mae_pct": position.mae_pct,
                "pending_mfe_pct": position.pending_mfe_pct,
                "unrealized_r": unrealized_r(snapshot, position, config),
            }
        return marks


#: How often the recorder settles. Slower than the 2s scan on purpose: it is
#: observation, not detection, and the price series it reads is unaffected by
#: how often it is sampled.
RECORDER_INTERVAL_SECONDS = 5.0

_recorder = ForwardTestRecorder()


def get_recorder() -> ForwardTestRecorder:
    return _recorder


async def start_forward_test_recorder() -> None:
    """Called from the FastAPI lifespan, after the radar is up."""
    if not momentum_cfg.ENABLED:
        logger.info("[forward-test] radar disabled; recorder not started")
        return
    resumed = await _recorder.resume()
    _recorder.start()
    logger.info(
        "[forward-test] recorder started (%s, generation %d, %d resumed)",
        STRATEGY_VERSION,
        DETECTOR_GENERATION,
        resumed,
    )


async def stop_forward_test_recorder() -> None:
    await _recorder.stop()
