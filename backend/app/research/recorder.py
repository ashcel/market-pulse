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

from smc.forward_test import (
    DEFAULT_FORWARD_TEST_CONFIG,
    FORWARD_TEST_VERSION,
    OPEN_STATUSES,
    ForwardTestConfig,
    LifecycleEvent,
    PaperPosition,
    SetupSnapshot,
    advance_position,
    default_variants,
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

logger = logging.getLogger("research.recorder")

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
DETECTOR_GENERATION = 5


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
        },
        "active_stop": position.active_stop,
        "trailing_mode": position.trailing_mode,
        "last_price": position.last_price,
        "updated_at": repo.to_utc(position.updated_at),
    }


def _variant_config(primary: ForwardTestConfig, name: str) -> ForwardTestConfig:
    for variant in default_variants(primary):
        if variant.name == name:
            return variant.config
    return primary


def lifecycle_values(
    position: PaperPosition,
    event_count: int,
    variants: dict[str, PaperPosition] | None = None,
) -> dict[str, object]:
    """The update payload — lifecycle and outcome only."""
    return {
        "gross_r": position.gross_r,
        "cost_r": position.cost_r,
        "variants": {
            name: {
                "status": outcome_for(name, alt).status,
                "realized_r": alt.realized_r,
                "gross_r": alt.gross_r,
                "cost_r": alt.cost_r,
                "mfe_r": alt.mfe_r,
                "mae_r": alt.mae_r,
                "exit_reason": alt.exit_reason,
            }
            for name, alt in (variants or {}).items()
        }
        or None,
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

    async def resume(self) -> int:
        """Reloads hypotheses that were still open when the process stopped.

        Without this a restart silently orphans every in-flight record: the row
        stays OPEN forever, never settles, and quietly biases the dataset
        toward whatever happened to be closed already. Returns how many were
        picked back up.
        """
        async with SessionFactory() as db:
            rows = await repo.open_setups(db)
        for row in rows:
            key = row.setup_key
            if key in self._open or key in self._closed:
                continue
            self._open[key] = (
                str(row.id),
                snapshot_from_row(row),
                position_from_row(row),
                row.event_count,
            )
        if rows:
            logger.info("[forward-test] resumed %d open setup(s) after restart", len(rows))
        return len(rows)

    async def stop(self) -> None:
        self._stopping = True
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
            frozen = snapshot_from(situation, now, profile_for(situation.mode).forward_test)
            if frozen is None:
                continue
            profile = profile_for(situation.mode)
            config = profile.forward_test
            frozen = with_flow(frozen, entry.metrics, entry.structural)
            position, events = open_position(frozen, now, entry.metrics.price, config)
            # The same hypothesis under alternative exit rules. Identical
            # detection, identical entry, identical price stream — the only
            # honest way to compare exits.
            variants = {
                variant.name: open_position(frozen, now, entry.metrics.price, variant.config)[0]
                for variant in default_variants(config)
            }

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
                    continue
                await repo.insert_events(db, [event_values(setup_id, e) for e in events])
            self._open[key] = (setup_id, frozen, position, len(events))
            self._variants[key] = variants
            self.captured += 1
            writes += 1
            logger.info(
                "[forward-test] captured %s %s %s @ %.6g (%.1fR)",
                frozen.mode,
                frozen.symbol,
                frozen.direction,
                frozen.reference_entry,
                frozen.potential_rr,
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
            for name, variant_position in list(alternatives.items()):
                moved, _ = advance_position(
                    snapshot,
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
                self._closed.add(key)
                self.settled += 1
                logger.info(
                    "[forward-test] settled %s %s → %s (%.2fR)",
                    snapshot.mode,
                    snapshot.symbol,
                    advanced.status,
                    advanced.realized_r,
                )
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
