"""Forward-test repo — the Python worker's only SQL surface (mirror of the
legacy TS `src/server/db/repo.ts` semantics).

Idempotency contract, unchanged from the TS worker:
- open_* rely on the partial unique indexes + ON CONFLICT DO NOTHING, so a
  crashed-and-restarted pass can never double-open a record;
- patch_* COALESCE every field, so a re-issued settle patch is a no-op;
- provenance is asserted right before insert — a record with a blank stamp
  would pool into version-segmented stats forever.
"""

from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any, cast

from smc.anticipatory import AnticipatorySignal, AnticipatorySignalDraft
from smc.hysteresis import HeldVerdict, TriggerLevel
from smc.quant import RiskRewardPlan
from smc.shadow import ShadowSignal, ShadowSignalDraft
from smc.tracker import TrackedSignal
from smc.version import Provenance, assert_provenance
from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AnticipatorySignalRow, EngineRun, EvalLog, ShadowSignalRow, VerdictHold


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# ── Engine runs ──────────────────────────────────────────────────────────────


async def start_engine_run(db: AsyncSession, prov: Provenance, universe: object) -> str:
    run = EngineRun(
        engine_version=prov.engine_version,
        config_hash=prov.config_hash,
        git_sha=prov.git_sha,
        universe_json=cast("dict[str, Any]", universe),
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    return run.id


async def finish_engine_run(
    db: AsyncSession, run_id: str, status: str, note: str | None = None
) -> None:
    await db.execute(
        update(EngineRun)
        .where(EngineRun.id == run_id)
        .values(finished_at=text("now()"), status=status, note=note)
    )
    await db.commit()


async def count_open_records(db: AsyncSession) -> dict[str, int]:
    row = (
        await db.execute(
            text(
                "select"
                " (select count(*) from shadow_signal where status = 'active') as shadow,"
                " (select count(*) from anticipatory_signal"
                "   where status in ('pending', 'filled')) as anticipatory,"
                " (select count(*) from tracked_signal where status = 'active') as tracked"
            )
        )
    ).one()
    return {"shadow": row.shadow, "anticipatory": row.anticipatory, "tracked": row.tracked}


# ── Shadow record ────────────────────────────────────────────────────────────


def _row_to_shadow(r: ShadowSignalRow) -> ShadowSignal:
    return ShadowSignal(
        id=r.id,
        symbol=r.symbol,
        market=r.market,  # type: ignore[arg-type]
        intent=r.intent,  # type: ignore[arg-type]
        direction=r.direction,  # type: ignore[arg-type]
        setup_type=r.setup_type,  # type: ignore[arg-type]
        regime=r.regime,  # type: ignore[arg-type]
        timeframe=r.timeframe,  # type: ignore[arg-type]
        entry=r.entry,
        stop=r.stop,
        target1=r.target1,
        target2=r.target2,
        confidence=r.confidence,
        opened_at=_iso(r.opened_at) or "",
        status=r.status,  # type: ignore[arg-type]
        closed_at=_iso(r.closed_at),
        close_price=r.close_price,
        result_r=r.result_r,
        objective_resolved=r.objective_resolved,
        engine_version=r.engine_version,
        config_hash=r.config_hash,
        git_sha=r.git_sha,
    )


async def open_shadow(db: AsyncSession, draft: ShadowSignalDraft, engine_run_id: str) -> None:
    """Opens a shadow record; the partial unique index no-ops a still-open duplicate."""
    assert_provenance(draft.engine_version, draft.config_hash, draft.git_sha)
    stmt = (
        pg_insert(ShadowSignalRow)
        .values(
            symbol=draft.symbol,
            market=draft.market,
            intent=draft.intent,
            direction=draft.direction,
            setup_type=draft.setup_type,
            regime=draft.regime,
            timeframe=draft.timeframe,
            entry=draft.entry,
            stop=draft.stop,
            target1=draft.target1,
            target2=draft.target2,
            confidence=draft.confidence,
            objective_resolved=draft.objective_resolved,
            opened_at=_parse_iso(draft.opened_at),
            engine_version=draft.engine_version,
            config_hash=draft.config_hash,
            git_sha=draft.git_sha,
            engine_run_id=engine_run_id,
        )
        .on_conflict_do_nothing()
    )
    await db.execute(stmt)
    await db.commit()


async def list_open_shadow(db: AsyncSession) -> list[ShadowSignal]:
    rows = (
        (await db.execute(select(ShadowSignalRow).where(ShadowSignalRow.status == "active")))
        .scalars()
        .all()
    )
    return [_row_to_shadow(r) for r in rows]


async def load_shadow_signals(
    db: AsyncSession, engine_version: str | None = None
) -> list[ShadowSignal]:
    stmt = select(ShadowSignalRow)
    if engine_version is not None:
        stmt = stmt.where(ShadowSignalRow.engine_version == engine_version)
    rows = (await db.execute(stmt)).scalars().all()
    return [_row_to_shadow(r) for r in rows]


async def patch_shadow(
    db: AsyncSession,
    signal_id: str,
    status: str,
    closed_at: str | None,
    close_price: float | None,
    result_r: float | None,
) -> None:
    await db.execute(
        text(
            "update shadow_signal set"
            " status = coalesce(:status, status),"
            " closed_at = coalesce(cast(:closed_at as timestamptz), closed_at),"
            " close_price = coalesce(:close_price, close_price),"
            " result_r = coalesce(:result_r, result_r)"
            " where id = :id"
        ),
        {
            "id": signal_id,
            "status": status,
            "closed_at": closed_at,
            "close_price": close_price,
            "result_r": result_r,
        },
    )
    await db.commit()


# ── Anticipatory record ──────────────────────────────────────────────────────


def _row_to_anticipatory(r: AnticipatorySignalRow) -> AnticipatorySignal:
    return AnticipatorySignal(
        id=r.id,
        symbol=r.symbol,
        market=r.market,  # type: ignore[arg-type]
        intent=r.intent,  # type: ignore[arg-type]
        direction=r.direction,  # type: ignore[arg-type]
        setup_type=r.setup_type,  # type: ignore[arg-type]
        regime=r.regime,  # type: ignore[arg-type]
        timeframe=r.timeframe,  # type: ignore[arg-type]
        verdict=r.verdict,  # type: ignore[arg-type]
        entry=r.entry,
        stop=r.stop,
        objective=r.objective,
        objective_strength=r.objective_strength,  # type: ignore[arg-type]
        zone_freshness=r.zone_freshness,  # type: ignore[arg-type]
        reward_risk=r.reward_risk,
        opened_at=_iso(r.opened_at) or "",
        status=r.status,  # type: ignore[arg-type]
        filled_at=_iso(r.filled_at),
        closed_at=_iso(r.closed_at),
        close_price=r.close_price,
        result_r=r.result_r,
        engine_version=r.engine_version,
        config_hash=r.config_hash,
        git_sha=r.git_sha,
    )


async def open_anticipatory(
    db: AsyncSession, draft: AnticipatorySignalDraft, engine_run_id: str
) -> None:
    assert_provenance(draft.engine_version, draft.config_hash, draft.git_sha)
    stmt = (
        pg_insert(AnticipatorySignalRow)
        .values(
            symbol=draft.symbol,
            market=draft.market,
            intent=draft.intent,
            direction=draft.direction,
            setup_type=draft.setup_type,
            regime=draft.regime,
            timeframe=draft.timeframe,
            verdict=draft.verdict,
            entry=draft.entry,
            stop=draft.stop,
            objective=draft.objective,
            objective_strength=draft.objective_strength,
            zone_freshness=draft.zone_freshness,
            reward_risk=draft.reward_risk,
            opened_at=_parse_iso(draft.opened_at),
            engine_version=draft.engine_version,
            config_hash=draft.config_hash,
            git_sha=draft.git_sha,
            engine_run_id=engine_run_id,
        )
        .on_conflict_do_nothing()
    )
    await db.execute(stmt)
    await db.commit()


async def list_open_anticipatory(db: AsyncSession) -> list[AnticipatorySignal]:
    rows = (
        (
            await db.execute(
                select(AnticipatorySignalRow).where(
                    AnticipatorySignalRow.status.in_(("pending", "filled"))
                )
            )
        )
        .scalars()
        .all()
    )
    return [_row_to_anticipatory(r) for r in rows]


async def patch_anticipatory(
    db: AsyncSession,
    signal_id: str,
    status: str,
    filled_at: str | None,
    closed_at: str | None,
    close_price: float | None,
    result_r: float | None,
) -> None:
    await db.execute(
        text(
            "update anticipatory_signal set"
            " status = coalesce(:status, status),"
            " filled_at = coalesce(cast(:filled_at as timestamptz), filled_at),"
            " closed_at = coalesce(cast(:closed_at as timestamptz), closed_at),"
            " close_price = coalesce(:close_price, close_price),"
            " result_r = coalesce(:result_r, result_r)"
            " where id = :id"
        ),
        {
            "id": signal_id,
            "status": status,
            "filled_at": filled_at,
            "closed_at": closed_at,
            "close_price": close_price,
            "result_r": result_r,
        },
    )
    await db.commit()


# ── Verdict holds (server-owned hysteresis state) ────────────────────────────


def hold_to_json(hold: HeldVerdict) -> dict[str, Any]:
    """Snake_case JSON of the engine dataclass (nested plan/levels included).
    The 2.0.0 reset wiped the table, so no camelCase legacy rows exist."""
    return asdict(hold)


def hold_from_json(data: dict[str, Any]) -> HeldVerdict:
    plan = data.get("plan")
    invalidation = data.get("invalidation")
    upgrade_trigger = data.get("upgrade_trigger")
    return HeldVerdict(
        symbol=data["symbol"],
        market=data["market"],
        execution_timeframe=data["execution_timeframe"],
        intent=data["intent"],
        verdict=data["verdict"],
        direction=data["direction"],
        is_counter_trend=data["is_counter_trend"],
        size_multiplier=data["size_multiplier"],
        headline=data["headline"],
        summary=data["summary"],
        triggers=list(data.get("triggers") or []),
        confidence=data["confidence"],
        plan=RiskRewardPlan(**plan) if plan is not None else None,
        setup_type=data["setup_type"],
        context_bias=data["context_bias"],
        held_at=data["held_at"],
        invalidation=TriggerLevel(**invalidation) if invalidation is not None else None,
        upgrade_trigger=TriggerLevel(**upgrade_trigger) if upgrade_trigger is not None else None,
        adopted_because=data.get("adopted_because"),
    )


async def load_holds(db: AsyncSession, symbol: str, market: str) -> dict[str, HeldVerdict]:
    rows = (
        (
            await db.execute(
                select(VerdictHold).where(
                    VerdictHold.symbol == symbol, VerdictHold.market == market
                )
            )
        )
        .scalars()
        .all()
    )
    return {r.hold_key: hold_from_json(r.data) for r in rows}


async def upsert_holds(
    db: AsyncSession, symbol: str, market: str, updates: dict[str, HeldVerdict]
) -> None:
    if not updates:
        return
    for key, hold in updates.items():
        stmt = pg_insert(VerdictHold).values(
            hold_key=key,
            symbol=symbol,
            market=market,
            data=hold_to_json(hold),
            updated_at=text("now()"),
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[VerdictHold.hold_key],
            set_={"data": stmt.excluded.data, "updated_at": text("now()")},
        )
        await db.execute(stmt)
    await db.commit()


# ── Tracked signals (user-owned; worker settles, web app writes) ─────────────


async def list_open_tracked(db: AsyncSession) -> list[TrackedSignal]:
    rows = (
        await db.execute(
            text(
                "select id, symbol, intent, direction, setup_type, timeframe, market,"
                " entry_low, entry_high, entry_price, stop, target1, target2,"
                " confidence_at_follow, followed_at, status,"
                " engine_version, config_hash, git_sha"
                " from tracked_signal where status = 'active'"
            )
        )
    ).all()
    return [
        TrackedSignal(
            id=str(r.id),
            symbol=r.symbol,
            intent=r.intent,
            direction=r.direction,
            setup_type=r.setup_type,
            timeframe=r.timeframe,
            market=r.market,
            entry_low=r.entry_low,
            entry_high=r.entry_high,
            entry_price=r.entry_price,
            stop=r.stop,
            target1=r.target1,
            target2=r.target2,
            confidence_at_follow=r.confidence_at_follow,
            followed_at=_iso(r.followed_at) or "",
            status=r.status,
            engine_version=r.engine_version,
            config_hash=r.config_hash,
            git_sha=r.git_sha,
        )
        for r in rows
    ]


async def patch_tracked(
    db: AsyncSession,
    signal_id: str,
    status: str,
    closed_at: str | None,
    close_price: float | None,
    result_r: float | None,
) -> None:
    await db.execute(
        text(
            "update tracked_signal set"
            " status = coalesce(:status, status),"
            " closed_at = coalesce(cast(:closed_at as timestamptz), closed_at),"
            " close_price = coalesce(:close_price, close_price),"
            " result_r = coalesce(:result_r, result_r)"
            " where id = :id"
        ),
        {
            "id": signal_id,
            "status": status,
            "closed_at": closed_at,
            "close_price": close_price,
            "result_r": result_r,
        },
    )
    await db.commit()


# ── Eval log ─────────────────────────────────────────────────────────────────


async def insert_eval_log(
    db: AsyncSession,
    engine_run_id: str,
    symbol: str,
    market: str,
    entries: list[dict[str, Any]],
    prov: Provenance,
) -> None:
    """Bulk-inserts one pass's assessment log rows (already flattened by the
    caller — see worker.passes.log_eval_assessments)."""
    if not entries:
        return
    for entry in entries:
        db.add(
            EvalLog(
                engine_run_id=engine_run_id,
                symbol=symbol,
                market=market,
                engine_version=prov.engine_version,
                config_hash=prov.config_hash,
                git_sha=prov.git_sha,
                **entry,
            )
        )
    await db.commit()
