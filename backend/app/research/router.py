"""FORWARD-TEST research API.

Read-only by construction: there is no endpoint that writes, edits or deletes a
setup. That is deliberate — a forward test whose bad rows can be pruned by hand
is not a forward test, and the absence of a delete route is the cheapest way to
guarantee nobody prunes one at 2am.

* `GET /research/forward-test`            — summary cards, stats, and the table.
* `GET /research/forward-test/{id}`       — one setup with its full lifecycle.
* `GET /research/versions`                — the cohorts, and what pools with what.

Public, like the other research reads: derived market data, no user content.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from smc.forward_test import compute_stats
from smc.version_archive import ARCHIVE, VERSION_ARCHIVE_VERSION
from smc.version_archive import LIVE as LIVE_RELEASE
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.momentum.scanner import get_scanner
from app.research import repo
from app.research.models import ForwardTestSetup
from app.research.recorder import DETECTOR_GENERATION, STRATEGY_VERSION, get_recorder
from app.research.schemas import (
    ForwardTestData,
    ForwardTestDetailData,
    ForwardTestDetailEnvelope,
    ForwardTestEnvelope,
    ForwardTestEventResponse,
    ForwardTestSetupResponse,
    ForwardTestStatsResponse,
    ForwardTestSummaryResponse,
    VersionArchiveData,
    VersionArchiveEnvelope,
    VersionPoolResponse,
    VersionReleaseResponse,
)
from app.research.version_report import build_report as build_version_report

router = APIRouter(prefix="/research", tags=["research"])

DbSession = Annotated[AsyncSession, Depends(get_db)]

SECONDS_PER_DAY = 86_400.0


def _epoch(value: datetime | None) -> float | None:
    """Instant → epoch seconds; see `repo.from_utc` on why naive means UTC."""
    return repo.from_utc(value)


def _stats_by_regime(
    rows: list[tuple[str, str, float, float, float]],
) -> dict[str, ForwardTestStatsResponse]:
    """The population statistics, one bucket per tape.

    Buckets are whatever the rows actually contain — nothing is pre-seeded, so
    an empty bucket never appears as a zero-sample result that looks measured.
    Detection order is preserved inside each bucket, which is what keeps the
    per-regime drawdown curve chronological.
    """
    grouped: dict[str, list[tuple[str, float, float, float]]] = {}
    for regime, status, realized, mfe, mae in rows:
        grouped.setdefault(regime, []).append((status, realized, mfe, mae))
    return {
        regime: ForwardTestStatsResponse(**asdict(compute_stats(bucket)))
        for regime, bucket in grouped.items()
    }


def _to_setup(
    row: ForwardTestSetup, marks: dict[str, dict[str, float | None]] | None = None
) -> ForwardTestSetupResponse:
    detected = _epoch(row.detected_at) or 0.0
    entered = _epoch(row.entered_at)
    settled = _epoch(row.settled_at)
    # An open row is only current as of its last transition; the live mark is
    # the same position as of the last observation. Read-only, in-memory, and
    # applied to open rows alone — nothing here can touch a settled outcome.
    mark = (marks or {}).get(str(row.id)) or {}
    now = datetime.now(tz=UTC).timestamp()
    return ForwardTestSetupResponse(
        id=str(row.id),
        symbol=row.symbol,
        market=row.market,
        mode=row.mode,
        direction=row.direction,
        status=row.status,
        detected_at=detected,
        state=row.state,
        tier=row.tier,
        combo=row.combo,
        score=row.score,
        entry_low=row.entry_low,
        entry_high=row.entry_high,
        reference_entry=row.reference_entry,
        initial_invalidation=row.initial_invalidation,
        target=row.target,
        target_kind=row.target_kind,
        potential_rr=row.potential_rr,
        htf_bias=row.htf_bias,
        alignment=row.alignment,
        alignment_level=row.alignment_level,
        regime=row.regime or "",
        evidence=row.evidence or {},
        active_stop=float(mark.get("active_stop") or row.active_stop),
        trailing_mode=row.trailing_mode,
        trailing_activated_at=_epoch(row.trailing_activated_at),
        trailing_updates=[list(update) for update in (row.trailing_updates or [])],
        zone_touched_at=_epoch(row.zone_touched_at),
        entered_at=entered,
        entry_price=row.entry_price,
        settled_at=settled,
        exit_price=row.exit_price,
        exit_reason=row.exit_reason,
        realized_r=row.realized_r,
        gross_r=row.gross_r,
        cost_r=row.cost_r,
        variants=row.variants or {},
        exit_regime=row.exit_regime or "",
        mfe_pct=float(mark.get("mfe_pct") if mark.get("mfe_pct") is not None else row.mfe_pct),
        mae_pct=float(mark.get("mae_pct") if mark.get("mae_pct") is not None else row.mae_pct),
        mfe_r=float(mark.get("mfe_r") if mark.get("mfe_r") is not None else row.mfe_r),
        mae_r=float(mark.get("mae_r") if mark.get("mae_r") is not None else row.mae_r),
        pending_mfe_pct=float(
            mark.get("pending_mfe_pct")
            if mark.get("pending_mfe_pct") is not None
            else row.pending_mfe_pct
        ),
        # Floating R, marked at the last observed price and already charged the
        # full round trip — an open number that flatters itself by omitting
        # costs is not comparable with the settled one it becomes. Zero once
        # settled, where `realized_r` is the answer.
        unrealized_r=float(mark.get("unrealized_r") or 0.0),
        touched_zone=row.touched_zone,
        # Derived on read rather than stored: they are pure functions of
        # timestamps already on the row. An open position is measured to *now*,
        # which is why this clock moves without a write.
        time_to_entry=round(entered - detected, 2) if entered is not None else None,
        time_in_trade=(
            round((settled if settled is not None else now) - entered, 2)
            if entered is not None
            else None
        ),
        last_price=float(mark.get("last_price") or row.last_price),
        updated_at=float(mark.get("updated_at") or 0.0) or (_epoch(row.updated_at) or 0.0),
        strategy_version=row.strategy_version,
        engine_version=row.engine_version,
        config_hash=row.config_hash,
        git_sha=row.git_sha,
        versions=row.versions or {},
    )


@router.get(
    "/forward-test",
    response_model=ForwardTestEnvelope,
    summary="Recorded forward-test setups, their outcomes and the aggregate statistics",
)
async def get_forward_test(
    mode: str | None = None,
    status: str | None = None,
    # Defaults to the current detector generation: rows produced by different
    # geometry are different experiments and must not be averaged together.
    # `generation=0` explicitly asks for every cohort.
    generation: int = DETECTOR_GENERATION,
    limit: int = 100,
    offset: int = 0,
    db: DbSession = None,  # type: ignore[assignment]
) -> ForwardTestEnvelope:
    """Every qualifying setup the scanner has confirmed, with what happened
    next. No filtering by outcome is applied server-side beyond the requested
    `status`: the dataset is only honest if the losers are in it."""
    normalized = mode.strip().upper() if mode else None
    cohort = generation if generation > 0 else None
    rows = await repo.list_setups(
        db,
        mode=normalized,
        status=status.strip().upper() if status else None,
        generation=cohort,
        limit=max(1, min(500, limit)),
        offset=max(0, offset),
    )
    stats = compute_stats(await repo.outcome_rows(db, mode=normalized, generation=cohort))
    by_regime = _stats_by_regime(
        await repo.regime_outcome_rows(db, mode=normalized, generation=cohort)
    )
    first = await repo.first_detection(db, mode=normalized, generation=cohort)
    best = await repo.best_setup(db, mode=normalized, generation=cohort)
    recorder = get_recorder()
    marks = recorder.live_marks()

    started = _epoch(first)
    days = (
        round((datetime.now(tz=UTC).timestamp() - started) / SECONDS_PER_DAY, 2)
        if started is not None
        else 0.0
    )
    return ForwardTestEnvelope(
        data=ForwardTestData(
            mode=normalized,
            summary=ForwardTestSummaryResponse(
                days_running=days,
                first_detected_at=started,
                setups_recorded=await repo.count_setups(
                    db, mode=normalized, generation=cohort
                ),
                open_now=recorder.open_count,
                scanned_universe=get_scanner().snapshot().universe_size,
                strategy_version=STRATEGY_VERSION,
                config_hash=best.config_hash if best is not None else "",
                git_sha=best.git_sha if best is not None else "",
                best_setup=_to_setup(best, marks) if best is not None else None,
            ),
            # `asdict`, not `__dict__`: the stats dataclass uses slots.
            stats=ForwardTestStatsResponse(**asdict(stats)),
            by_regime=by_regime,
            setups=[_to_setup(row, marks) for row in rows],
        )
    )


@router.get(
    "/forward-test/{setup_id}",
    response_model=ForwardTestDetailEnvelope,
    summary="One recorded setup and its full, append-only lifecycle",
)
async def get_forward_test_setup(
    setup_id: str, db: DbSession = None  # type: ignore[assignment]
) -> ForwardTestDetailEnvelope:
    row = await db.get(ForwardTestSetup, setup_id)
    if row is None:
        raise HTTPException(status_code=404, detail="setup not found")
    events = await repo.events_for(db, setup_id)
    return ForwardTestDetailEnvelope(
        data=ForwardTestDetailData(
            setup=_to_setup(row, get_recorder().live_marks()),
            events=[
                ForwardTestEventResponse(
                    type=event.type,
                    ts=_epoch(event.ts) or 0.0,
                    price=event.price,
                    detail=event.detail or {},
                )
                for event in events
            ],
        )
    )


@router.get(
    "/versions",
    response_model=VersionArchiveEnvelope,
    summary="Every recorded detector cohort, what it changed, and what may be pooled with it",
)
async def get_version_archive(db: DbSession = None) -> VersionArchiveEnvelope:  # type: ignore[assignment]
    """The archive joined to the record.

    Exists so a client can filter by cohort without inventing the rule itself.
    `/research/forward-test?generation=N` has always taken the filter; what was
    missing is the list of values it accepts and — the part no dropdown can
    infer — which of them may be shown as a single number. Generation 6 changed
    only how the round trip is priced, so `gross_r` pools across it and
    `realized_r` does not, and a UI that offered one "version" switch for both
    would be wrong half the time.
    """
    report = await build_version_report(db)
    by_generation = {c.generation: c for c in report.cohorts}
    unstamped = by_generation.get(None)

    releases = []
    for release in ARCHIVE:
        cohort = by_generation.get(release.generation)
        releases.append(
            VersionReleaseResponse(
                generation=release.generation,
                strategy_version=release.strategy_version,
                forward_test_version=release.forward_test_version,
                summary=release.summary,
                opened=release.opened.isoformat(),
                changed=list(release.changed),
                note=release.note,
                gross_comparable=release.gross_comparable,
                net_comparable=release.net_comparable,
                population_comparable=release.population_comparable,
                detected=cohort.detected if cohort else 0,
                filled=cohort.filled if cohort else 0,
                settled=cohort.settled if cohort else 0,
                first_detected_at=_epoch(cohort.first_seen) if cohort else None,
                last_detected_at=_epoch(cohort.last_seen) if cohort else None,
            )
        )

    return VersionArchiveEnvelope(
        data=VersionArchiveData(
            archive_version=VERSION_ARCHIVE_VERSION,
            live_generation=LIVE_RELEASE.generation,
            live_strategy_version=LIVE_RELEASE.strategy_version,
            releases=releases,
            pools=[
                VersionPoolResponse(
                    metric=pool.metric,
                    generations=list(pool.generations),
                    excluded=list(pool.excluded),
                    n=pool.n,
                )
                for pool in report.pools
            ],
            unstamped=unstamped.detected if unstamped else 0,
        )
    )
