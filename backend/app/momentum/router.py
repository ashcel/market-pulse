"""MOMENTUM RADAR read API.

Three surfaces over the same in-memory snapshot:

* `GET /momentum/scan`   — one JSON snapshot (polling fallback, and what the
  first paint uses).
* `GET /momentum/stream` — SSE push at `STREAM_INTERVAL_SECONDS`, so the page
  behaves like a live radar instead of a refresh loop. SSE rather than a
  websocket because the retained web tier proxying this cannot upgrade
  connections (see CLAUDE.md).
* `GET /momentum/timeline/{symbol}` — one symbol's full event sequence, for the
  "what actually happened here" view behind a card.

Public, like the other market-data reads: provider data plus a deterministic
derivation, no user content, so no session check.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from smc.context_alignment import Alignment
from smc.liquidity_targets import Target
from smc.market_context import MarketContext
from smc.market_regime import regime_payload
from smc.momentum_events import MarketEvent
from smc.pullback import PullbackRead
from smc.pullback_completion import CompletionRead
from smc.scan_profiles import MODES, profile_for
from smc.structural_path import StructuralPath
from smc.structure_map import StructuralLevel

from app.momentum import config as cfg
from app.momentum.scanner import MomentumScanner, RadarEntry, RadarSnapshot, get_scanner
from app.momentum.schemas import (
    AlignmentResponse,
    CompletionResponse,
    ContextResponse,
    EventResponse,
    EvidenceResponse,
    FunnelResponse,
    JournalData,
    JournalEntryResponse,
    JournalEnvelope,
    LevelResponse,
    PathResponse,
    PullbackResponse,
    RadarData,
    RadarEntryResponse,
    RadarEnvelope,
    RegimeResponse,
    StructuralBackingResponse,
    TargetResponse,
    TelemetryResponse,
    TimeframeReadResponse,
    TimelineData,
    TimelineEnvelope,
)

router = APIRouter(prefix="/momentum", tags=["momentum"])

# Only the last few events ride on a card — enough to explain what is on
# screen. The full sequence is one request away, on /timeline.
HISTORY_TAIL = 6


def _to_event(event: MarketEvent, now: float, mode: str = "SCALP") -> EventResponse:
    events_config = profile_for(mode).events
    return EventResponse(
        type=event.type,
        direction=event.direction,
        ts=event.ts,
        last_seen_ts=event.last_seen_ts,
        magnitude=event.magnitude,
        peak_magnitude=event.peak_magnitude,
        unit=event.unit,
        score=event.score,
        qualifier=event.qualifier,
        active=event.is_active(now, events_config),
        age_seconds=round(event.age(now), 1),
    )


def _to_context(context: MarketContext | None) -> ContextResponse | None:
    if context is None:
        return None
    return ContextResponse(
        bias=context.bias,
        agreement=context.agreement,
        score=context.score,
        reads=[
            TimeframeReadResponse(
                timeframe=read.timeframe,
                bias=read.bias,
                trend=read.trend,
                event=read.event,
                event_label=read.event_label,
                change_pct=read.change_pct,
                bars=read.bars,
                computed_at=read.computed_at,
            )
            for read in context.reads
        ],
        updated_at=context.updated_at,
        bias_since=context.bias_since,
    )


def _to_alignment(alignment: Alignment) -> AlignmentResponse:
    return AlignmentResponse(
        level=alignment.level,
        classification=alignment.classification,
        agreement=alignment.agreement,
        context_bias=alignment.context_bias,
        event_direction=alignment.event_direction,
    )


def _to_level(level: StructuralLevel | None) -> LevelResponse | None:
    if level is None:
        return None
    return LevelResponse(
        price=level.price,
        kind=level.kind,
        timeframe=level.timeframe,
        touches=level.touches,
    )


def _to_pullback(read: PullbackRead | None) -> PullbackResponse | None:
    if read is None or read.state == "NONE":
        return None
    return PullbackResponse(
        state=read.state,
        retrace_frac=read.retrace_frac,
        retrace_pct=read.retrace_pct,
        duration_seconds=round(read.duration_seconds, 1),
        volume_ratio=read.volume_ratio,
        opposing_move_pct=read.opposing_move_pct,
        structure_intact=read.structure_intact,
        is_healthy=read.is_healthy,
        at_level=_to_level(read.at_level),
    )


def _to_completion(read: CompletionRead | None) -> CompletionResponse | None:
    if read is None:
        return None
    return CompletionResponse(
        state=read.state,
        met_count=read.met_count,
        has_trigger=read.has_trigger,
        evidence=[
            EvidenceResponse(code=item.code, met=item.met, detail=item.detail)
            for item in read.evidence
        ],
    )


def _to_target(target: Target) -> TargetResponse:
    level = _to_level(target.level)
    assert level is not None
    return TargetResponse(level=level, distance_pct=target.distance_pct)


def _to_path(path: StructuralPath | None) -> PathResponse | None:
    if path is None:
        return None
    return PathResponse(
        entry=path.entry,
        invalidation=path.invalidation,
        target=path.target,
        target_kind=path.target_kind,
        risk_pct=path.risk_pct,
        reward_pct=path.reward_pct,
        rr=path.rr,
        verdict=path.verdict,
    )


def _to_response(entry: RadarEntry, now: float) -> RadarEntryResponse:
    situation = entry.situation
    tracker_events = situation.headline
    metrics = entry.metrics
    return RadarEntryResponse(
        symbol=situation.symbol,
        state=situation.state,
        mode=situation.mode,
        direction=situation.direction,
        score=situation.score,
        headline=(
            _to_event(entry.headline, now, situation.mode) if entry.headline is not None else None
        ),
        events=(
            [_to_event(tracker_events, now, situation.mode)] if tracker_events is not None else []
        ),
        timeline=[],
        telemetry=TelemetryResponse(
            pressure=entry.pressure,
            change_1m_pct=metrics.change_1m_pct,
            change_3m_pct=metrics.change_3m_pct,
            change_5m_pct=metrics.change_5m_pct,
            change_15m_pct=metrics.change_15m_pct,
            change_24h_pct=metrics.change_24h_pct,
            rvol_1m=metrics.rvol_1m,
            rvol_3m=metrics.rvol_3m,
            rvol_5m=metrics.rvol_5m,
            trade_rate_mult=metrics.trade_rate_mult,
            range_expansion=metrics.range_expansion,
            quote_volume_1m=metrics.quote_volume_1m,
            quote_volume_24h=metrics.quote_volume_24h,
            trades_1m=metrics.trades_1m,
        ),
        tier=situation.tier,
        combo=situation.combo,
        families=list(situation.families),
        structural=(
            StructuralBackingResponse(
                state=entry.structural.state,
                score=entry.structural.score,
                side=entry.structural.side,
                detected_at=entry.structural.detected_at,
            )
            if entry.structural is not None
            else None
        ),
        context=_to_context(situation.context),
        alignment=_to_alignment(situation.alignment),
        pullback=_to_pullback(situation.pullback),
        completion=_to_completion(situation.completion),
        targets=[_to_target(t) for t in situation.targets],
        path=_to_path(situation.path),
        worth_watching=situation.worth_watching,
        reasons=list(situation.reasons),
        first_seen=situation.first_seen,
        state_since=situation.state_since,
        updated_at=situation.updated_at,
    )


def _to_data(snapshot: RadarSnapshot) -> RadarData:
    now = snapshot.updated_at
    funnel = snapshot.funnel
    return RadarData(
        updated_at=snapshot.updated_at,
        mode=snapshot.mode,
        version=snapshot.version,
        events_version=snapshot.events_version,
        context_version=snapshot.context_version,
        journal_version=snapshot.journal_version,
        universe_size=snapshot.universe_size,
        tracked=snapshot.tracked,
        connected=snapshot.connected,
        feed=snapshot.feed,
        warming_up=snapshot.warming_up,
        regime=RegimeResponse(**regime_payload(snapshot.regime)),
        funnel=FunnelResponse(
            universe=funnel.universe,
            tracked=funnel.tracked,
            events=funnel.events,
            qualified=funnel.qualified,
            directional=funnel.directional,
            structural=funnel.structural,
            developing=funnel.developing,
            surfaced=funnel.surfaced,
        ),
        situations=[_to_response(e, now) for e in snapshot.situations],
        closed=[_to_response(e, now) for e in snapshot.closed],
        counts=dict(snapshot.counts),
    )


@router.get(
    "/scan",
    response_model=RadarEnvelope,
    summary="Compressed realtime radar snapshot: the few situations worth opening",
)
async def get_scan(mode: str = "SCALP") -> RadarEnvelope:
    """`mode` selects the trading horizon (SCALP | INTRADAY). An unknown value
    degrades to scalp rather than erroring."""
    return RadarEnvelope(data=_to_data(get_scanner().snapshot(mode)))


@router.get(
    "/timeline/{symbol}",
    response_model=TimelineEnvelope,
    summary="One symbol's full sequence of detected market events",
)
async def get_timeline(symbol: str, mode: str = "SCALP") -> TimelineEnvelope:
    scanner = get_scanner()
    resolved = profile_for(mode).mode
    tracker = scanner.tracker(symbol, resolved)
    now = scanner.snapshot(resolved).updated_at
    if tracker is None:
        # Not an error: a symbol with nothing happening simply has no events.
        return TimelineEnvelope(data=TimelineData(symbol=symbol.strip().upper()))
    return TimelineEnvelope(
        data=TimelineData(
            symbol=tracker.symbol,
            state=tracker.state,
            direction=tracker.direction,
            score=tracker.display_score,
            first_event_at=tracker.first_event_at,
            updated_at=tracker.updated_at,
            context=_to_context(tracker.context),
            alignment=_to_alignment(tracker.alignment),
            events=[_to_event(e, now, resolved) for e in tracker.timeline],
        )
    )


@router.get(
    "/journal",
    response_model=JournalEnvelope,
    summary="Recorded situations — what the scanner surfaced, and what happened next",
)
async def get_journal(mode: str = "SCALP", limit: int = 50) -> JournalEnvelope:
    """The backtestability surface.

    Every surfaced situation that reached at least PULLBACK is recorded with
    its context, its structural path and what price did afterwards (MFE/MAE,
    target/invalidation). Not trades — nothing here was ever sent anywhere; it
    exists so the detector can eventually be measured instead of argued about.

    In-memory and bounded, like the rest of this plane: a restart clears it.
    """
    resolved = profile_for(mode).mode
    journal = get_scanner().journal(resolved)
    rows = journal.recent(limit=max(1, min(500, limit)), mode=resolved)
    return JournalEnvelope(
        data=JournalData(
            mode=resolved,
            version=get_scanner().snapshot(resolved).journal_version,
            stats=journal.stats(resolved),
            entries=[
                JournalEntryResponse(
                    key=row.key,
                    symbol=row.symbol,
                    mode=row.mode,
                    direction=row.direction,
                    opened_at=row.opened_at,
                    trigger_type=row.trigger_type,
                    trigger_ts=row.trigger_ts,
                    context_bias=row.context_bias,
                    alignment=row.alignment,
                    alignment_level=row.alignment_level,
                    pullback_started_at=row.pullback_started_at,
                    completion_at=row.completion_at,
                    completion_evidence=list(row.completion_evidence),
                    entry=row.entry,
                    invalidation=row.invalidation,
                    target=row.target,
                    target_kind=row.target_kind,
                    rr=row.rr,
                    mfe_pct=row.mfe_pct,
                    mae_pct=row.mae_pct,
                    reached_completion=row.reached_completion,
                    reached_continuation=row.reached_continuation,
                    outcome=row.outcome,
                    closed_at=row.closed_at,
                    updated_at=row.updated_at,
                )
                for row in rows
            ],
        )
    )


@router.get(
    "/modes",
    summary="Available scan modes and the timeframes each one reads",
)
async def get_modes() -> dict[str, object]:
    return {
        "data": [
            {
                "mode": mode,
                "context": list(profile_for(mode).context_timeframes),
                "structure": list(profile_for(mode).structure_timeframes),
                "events": [
                    profile_for(mode).events.fast_window,
                    profile_for(mode).events.primary_window,
                ],
            }
            for mode in MODES
        ]
    }


@router.get(
    "/stream",
    summary="Server-sent stream of momentum radar snapshots",
    response_class=StreamingResponse,
)
async def get_stream(request: Request, mode: str = "SCALP") -> StreamingResponse:
    scanner: MomentumScanner = get_scanner()
    resolved = profile_for(mode).mode

    async def events() -> AsyncIterator[str]:
        last_revision = -1
        idle = 0.0
        # The first frame always goes out, even mid-warmup, so the UI can paint
        # its "warming up" state instead of an indefinite spinner.
        while True:
            if await request.is_disconnected():
                return
            snapshot = scanner.snapshot(resolved)
            if scanner.revision != last_revision:
                last_revision = scanner.revision
                idle = 0.0
                payload = _to_data(snapshot).model_dump(mode="json")
                yield f"event: radar\ndata: {json.dumps(payload)}\n\n"
            else:
                idle += cfg.STREAM_INTERVAL_SECONDS
                if idle >= cfg.STREAM_HEARTBEAT_SECONDS:
                    idle = 0.0
                    yield ": ping\n\n"
            await asyncio.sleep(cfg.STREAM_INTERVAL_SECONDS)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"cache-control": "no-cache, no-transform", "x-accel-buffering": "no"},
    )
