"""The forward-test worker passes — the system of record under 2.0.0.

Each tick: one eval pass per market (spot, then perp with real funding/OI
context) + one settle pass walking klines for every open record. Both are
idempotent — the partial unique indexes de-dup open records and the kline
walk is catch-up safe — so a crashed tick heals on the next one.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any

from smc.anticipatory import settle_anticipatory_signal
from smc.evaluate import EvaluateInput, evaluate_symbol
from smc.hysteresis import DisplayIntentAssessment, parse_iso_ms
from smc.market import WORKER_UNIVERSE
from smc.mock_candles import STEP_SECONDS, TokenTimeframe
from smc.shadow import settle_shadow_signal, shadow_combo_stats
from smc.tracker import settle_tracked_signal_with_candles
from smc.types import MarketType
from smc.version import ENGINE_VERSION, current_provenance
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionFactory
from app.forward_test import repo

from .binance import drop_unclosed_candle, fetch_klines, http_client
from .context_pass import run_context_pass
from .event_pass import run_event_pass
from .inputs import assemble_evaluate_inputs

logger = logging.getLogger("worker")

# Token-event / external-context ingestion cadence: news feeds and breadth
# providers update on minutes, not seconds — every third-ish tick is plenty,
# and a worker restart just ingests immediately (dedup makes that a no-op).
_EVENT_PASS_S = 15 * 60
_CONTEXT_PASS_S = 15 * 60
_last_event_pass_at = 0.0
_last_context_pass_at = 0.0


def _flatten_assessment(assessment: DisplayIntentAssessment) -> dict[str, Any]:
    """The eval_log row for one displayed assessment (mirror of
    logEvalAssessments in the TS worker)."""
    bt = assessment.execution.backtest
    component_scores = {
        comp.name: {
            "score": comp.score,
            "status": comp.status,
            "explanation": comp.explanation,
        }
        for comp in assessment.execution.components
    }
    return {
        "intent": assessment.intent,
        "verdict": assessment.verdict,
        "direction": None if assessment.direction == "none" else assessment.direction,
        "setup_type": assessment.execution.setup_type,
        "regime": assessment.execution.regime,
        "timeframe": assessment.definition.execution_timeframe,
        "confidence": assessment.confidence,
        "bt_win_rate": bt.win_rate,
        "bt_expectancy": bt.expectancy,
        "bt_avg_r": bt.average_r,
        "bt_total_trades": bt.total_trades,
        "bt_low_sample": bt.low_sample,
        "no_trade_reasons": assessment.execution.no_trade_reasons,
        "component_scores": component_scores,
    }


@dataclass(slots=True)
class EvalPassResult:
    evaluated: int = 0
    shadow_opened: int = 0
    anticipatory_opened: int = 0


async def run_eval_pass(
    db: AsyncSession, engine_run_id: str, market: MarketType = "spot"
) -> EvalPassResult:
    """One evaluation pass over the whole tracked universe: the engine runs
    for every asset on a schedule — whether or not anyone is looking — so the
    shadow/anticipatory record is unbiased. Exact evaluate_symbol pipeline,
    stamped with the current engine provenance."""
    prov = current_provenance()
    combo_stats = shadow_combo_stats(
        await repo.load_shadow_signals(db, ENGINE_VERSION), ENGINE_VERSION
    )
    result = EvalPassResult()

    for asset in WORKER_UNIVERSE:
        symbol = asset.ticker
        try:
            assembled = await assemble_evaluate_inputs(symbol, market)
            if assembled is None:
                continue

            holds = await repo.load_holds(db, symbol, market)
            out = evaluate_symbol(
                EvaluateInput(
                    symbol=symbol,
                    market=market,
                    evals_by_timeframe=assembled.evals_by_timeframe,
                    zones_by_timeframe=assembled.zones_by_timeframe,
                    perp=assembled.perp,
                    session_levels=assembled.session_levels,
                    combo_stats=combo_stats,
                    holds=holds,
                    now_ms=time.time() * 1000,
                )
            )
            if out is None:
                continue
            result.evaluated += 1

            await repo.upsert_holds(db, symbol, market, out.hold_updates)
            await repo.insert_eval_log(
                db,
                engine_run_id,
                symbol,
                market,
                [_flatten_assessment(a) for a in out.display],
                prov,
            )
            for shadow_draft in out.shadow_to_open:
                await repo.open_shadow(db, shadow_draft, engine_run_id)
                result.shadow_opened += 1
            for ant_draft in out.anticipatory_to_open:
                await repo.open_anticipatory(db, ant_draft, engine_run_id)
                result.anticipatory_opened += 1
        except Exception:
            await db.rollback()
            logger.exception("[eval] %s %s failed", symbol, market)

    return result


@dataclass(slots=True)
class _Group:
    symbol: str
    timeframe: TokenTimeframe
    market: MarketType
    earliest_sec: float
    shadow: list[Any] = field(default_factory=list)
    anticipatory: list[Any] = field(default_factory=list)
    tracked: list[Any] = field(default_factory=list)


async def run_settle_pass(db: AsyncSession) -> int:
    """One settlement pass over every open record — the same pure settlement
    functions the engine tests pin, run server-side so records settle whether
    or not a browser is open. Walking real intrabar highs/lows since each
    record opened makes worker restarts self-healing."""
    shadow = await repo.list_open_shadow(db)
    anticipatory = await repo.list_open_anticipatory(db)
    tracked = await repo.list_open_tracked(db)

    groups: dict[str, _Group] = {}

    def group_for(
        symbol: str, timeframe: TokenTimeframe, market: MarketType, opened_at: str
    ) -> _Group | None:
        sec = parse_iso_ms(opened_at) / 1000
        if not math.isfinite(sec):
            return None
        key = f"{symbol}:{timeframe}:{market}"
        group = groups.get(key)
        if group is None:
            group = _Group(symbol=symbol, timeframe=timeframe, market=market, earliest_sec=sec)
            groups[key] = group
        group.earliest_sec = min(group.earliest_sec, sec)
        return group

    for s in shadow:
        if (g := group_for(s.symbol, s.timeframe, s.market, s.opened_at)) is not None:
            g.shadow.append(s)
    for a in anticipatory:
        if (g := group_for(a.symbol, a.timeframe, a.market, a.opened_at)) is not None:
            g.anticipatory.append(a)
    for t in tracked:
        market: MarketType = t.market if t.market in ("spot", "perp") else "spot"
        if (g := group_for(t.symbol, t.timeframe, market, t.followed_at)) is not None:
            g.tracked.append(t)

    settled = 0
    for group in groups.values():
        step = STEP_SECONDS[group.timeframe]
        elapsed_bars = math.ceil((time.time() - group.earliest_sec) / step) + 3
        limit = min(1000, max(10, elapsed_bars))
        candles = drop_unclosed_candle(
            await fetch_klines(group.symbol, group.timeframe, limit=limit, market=group.market)
        )
        if not candles:
            continue

        for signal in group.shadow:
            patch = settle_shadow_signal(signal, candles)
            if patch is not None:
                await repo.patch_shadow(
                    db, signal.id, patch.status, patch.closed_at, patch.close_price, patch.result_r
                )
                settled += 1
        for signal in group.anticipatory:
            ant_patch = settle_anticipatory_signal(signal, candles)
            if ant_patch is not None:
                await repo.patch_anticipatory(
                    db,
                    signal.id,
                    ant_patch.status,
                    ant_patch.filled_at,
                    ant_patch.closed_at,
                    ant_patch.close_price,
                    ant_patch.result_r,
                )
                settled += 1
        for signal in group.tracked:
            tracked_patch = settle_tracked_signal_with_candles(signal, candles)
            if tracked_patch is not None:
                await repo.patch_tracked(
                    db,
                    signal.id,
                    tracked_patch.status,
                    tracked_patch.closed_at,
                    tracked_patch.close_price,
                    tracked_patch.result_r,
                )
                settled += 1

    return settled


async def run_once() -> str:
    """One full worker tick: engine_run bookkeeping + spot/perp eval passes +
    a settle pass, with token-event and external-context ingestion riding the
    same loop on a slower cadence (a feed failure is logged inside its pass
    and must never fail the forward-test tick). The one-line summary it
    returns/logs is the heartbeat the legacy health view reports on."""
    global _last_event_pass_at, _last_context_pass_at
    prov = current_provenance()
    started = time.monotonic()
    async with SessionFactory() as db:
        run_id = await repo.start_engine_run(
            db,
            prov,
            {
                "symbols": [asset.ticker for asset in WORKER_UNIVERSE],
                "markets": ["spot", "perp"],
            },
        )
        try:
            spot = await run_eval_pass(db, run_id, "spot")
            perp = await run_eval_pass(db, run_id, "perp")
            settled = await run_settle_pass(db)

            events = ""
            if time.time() - _last_event_pass_at >= _EVENT_PASS_S:
                _last_event_pass_at = time.time()
                try:
                    event_result = await run_event_pass(db, http_client())
                    events = f" events+={event_result.inserted}/{event_result.fetched}"
                except Exception:
                    await db.rollback()
                    logger.exception("[events] pass failed")

            ctx = ""
            if time.time() - _last_context_pass_at >= _CONTEXT_PASS_S:
                _last_context_pass_at = time.time()
                try:
                    ctx_result = await run_context_pass(db, http_client())
                    ctx = f" ctx global={ctx_result.global_}"
                    if ctx_result.calendar != "skipped":
                        ctx += f" cal={ctx_result.calendar}"
                        if ctx_result.calendar_written is not None:
                            ctx += f"+{ctx_result.calendar_written}"
                except Exception:
                    await db.rollback()
                    logger.exception("[context] pass failed")

            open_counts = await repo.count_open_records(db)

            note = (
                f"evaluated={spot.evaluated}+{perp.evaluated}p "
                f"shadowOpened={spot.shadow_opened + perp.shadow_opened} "
                f"anticipatoryOpened={spot.anticipatory_opened + perp.anticipatory_opened} "
                f"settled={settled}"
            )
            await repo.finish_engine_run(db, run_id, "ok", note)
            summary = (
                f"[worker] pass ok in {int((time.monotonic() - started) * 1000)}ms — "
                f"evaluated={spot.evaluated}spot+{perp.evaluated}perp "
                f"shadow+={spot.shadow_opened + perp.shadow_opened} "
                f"anticipatory+={spot.anticipatory_opened + perp.anticipatory_opened} "
                f"settled={settled}{events}{ctx} "
                f"open(shadow={open_counts['shadow']} "
                f"anticipatory={open_counts['anticipatory']} "
                f"tracked={open_counts['tracked']}) "
                f"(engine {prov.engine_version} / cfg {prov.config_hash})"
            )
            logger.info(summary)
            return summary
        except Exception as err:
            await db.rollback()
            try:
                await repo.finish_engine_run(db, run_id, "error", str(err))
            except Exception:
                logger.exception("[worker] failed to record error state")
            logger.exception("[worker] pass failed")
            raise
