"""Scorecard computation — reuses the SAME settlement code path as the
forward-test worker (docs/IMPLEMENTATION-PLAN.md §1.5-#5: "runner sendiri di
atas kode settlement forward-test yang sudah ada").

The scorecard joins `signal_events` to settled `shadow_signal` rows using
(source, symbol, side, horizon, detected_at window). The settlement result_r
from `shadow_signal` is the measure of success:
  - result_r > 0 → hit
  - result_r ≤ 0 → miss
  - result_r IS NULL → still open or never matched (excluded from counts)

n < EVIDENCE_MIN_N (20) → status='insufficient'. The raw hit_rate/avg_r are
still stored so the per-source fold can weight regime slices honestly, but no
reader is allowed to render them below the threshold — the API nulls them and
the UI says "Belum cukup data".

R3 compliance: the scorecard is ONLY built from `signal_events.detected_at`
(the time the source actually detected, live) and from settlements the
forward-test worker already wrote. Nothing here re-derives an outcome from
historical candles, which is what would turn a track record into a backtest
wearing its clothes.
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.forward_test.models import ShadowSignalRow
from app.opportunities.service import EVIDENCE_MIN_N
from app.scorecard.models import SourceScorecard
from app.signals.models import SignalEvent

logger = logging.getLogger("scorecard")

# `signal_events.side` and `shadow_signal.direction` share their vocabulary
# ('long'|'short'), so no mapping is needed there.
#
# Horizon maps to `shadow_signal.intent`, NOT to `timeframe`: the engine's
# intents are literally scalp/intraday/swing/position (engine/smc/intent.py),
# while `timeframe` holds the *execution* TF ('15M','1H','4H','1D'). Written as
# an explicit table rather than assumed identity so that renaming either
# vocabulary raises a KeyError here instead of silently scoring a scalp signal
# against a swing settlement.
_HORIZON_INTENT = {
    "scalp": "scalp",
    "intraday": "intraday",
    "swing": "swing",
    "position": "position",
}

# A settlement is credited to a signal only if the shadow record opened within
# this many seconds of the source's detection. Wider than one bar on purpose
# (the worker ticks every 5 min and the source's clock is its own), narrow
# enough that two unrelated setups on the same symbol do not collide.
_MATCH_WINDOW_S = 7200


async def compute_scorecard(
    db: AsyncSession,
    *,
    window_days: int = 30,
    now: datetime | None = None,
) -> list[SourceScorecard]:
    """Compute source_scorecard rows for every (source, source_version, regime,
    horizon) combination in signal_events over the last `window_days`.

    Settled `shadow_signal` records are the ground truth. A signal is matched to
    a shadow record on (symbol, side→direction, horizon→intent) when the shadow
    opened within `_MATCH_WINDOW_S` of the signal's `detected_at`. Each
    settlement is credited at most once per source.
    """
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=window_days)

    # Settled shadow records, fetched ONCE and bucketed. Doing this per-combo
    # re-reads the same rows for every source/version/horizon combination.
    settled_q = select(ShadowSignalRow).where(
        ShadowSignalRow.status.in_(("hit_tp", "hit_sl", "expired", "invalidated")),
        ShadowSignalRow.closed_at >= cutoff,
        ShadowSignalRow.result_r.is_not(None),
    )
    settled = (await db.execute(settled_q)).scalars().all()

    by_key: dict[tuple[str, str, str], list[ShadowSignalRow]] = {}
    for shadow in settled:
        by_key.setdefault((shadow.symbol, shadow.direction, shadow.intent), []).append(shadow)

    # Get all unique combos from signal_events within the window
    combos_q = (
        select(
            SignalEvent.source,
            SignalEvent.source_version,
            SignalEvent.horizon,
        )
        .where(SignalEvent.detected_at >= cutoff)
        .group_by(
            SignalEvent.source,
            SignalEvent.source_version,
            SignalEvent.horizon,
        )
    )
    combos = (await db.execute(combos_q)).all()

    rows: list[SourceScorecard] = []

    for source, source_version, horizon in combos:
        # Get all signals for this combo
        signals_q = select(SignalEvent).where(
            SignalEvent.source == source,
            SignalEvent.source_version == source_version,
            SignalEvent.horizon == horizon,
            SignalEvent.detected_at >= cutoff,
        )
        signals = (await db.execute(signals_q)).scalars().all()

        # Group settled results by the regime they settled in.
        regime_results: dict[str, list[float]] = {}
        # One settlement may be credited to at most one signal, or two
        # detectors firing on the same setup would each bank the same win and
        # inflate n. Scoped per combo: two different sources both deserve
        # credit for the same trade, the same source twice does not.
        consumed: set[str] = set()
        intent = _HORIZON_INTENT.get(horizon)

        for sig in signals:
            if intent is None:
                break  # unknown horizon: no settlement vocabulary to match on
            sig_dt = sig.detected_at
            if sig_dt.tzinfo is None:
                sig_dt = sig_dt.replace(tzinfo=UTC)

            for shadow in by_key.get((sig.symbol, sig.side, intent), ()):
                if shadow.id in consumed or shadow.result_r is None:
                    continue
                shadow_dt = shadow.opened_at
                if shadow_dt.tzinfo is None:
                    shadow_dt = shadow_dt.replace(tzinfo=UTC)

                if abs((sig_dt - shadow_dt).total_seconds()) <= _MATCH_WINDOW_S:
                    regime = shadow.regime or "unknown"
                    regime_results.setdefault(regime, []).append(shadow.result_r)
                    consumed.add(shadow.id)
                    break  # one match per signal

        # If no regime-matched results found, still emit a row with "unknown" regime
        if not regime_results:
            regime_results["unknown"] = []

        for regime, r_values in regime_results.items():
            n = len(r_values)
            hit_rate = sum(1 for r in r_values if r > 0) / n if n > 0 else None
            avg_r = sum(r_values) / n if n > 0 else None

            rows.append(
                SourceScorecard(
                    source=source,
                    source_version=source_version,
                    regime=regime,
                    horizon=horizon,
                    window_days=window_days,
                    n=n,
                    hit_rate=hit_rate,
                    avg_r=avg_r,
                    computed_at=now,
                )
            )

    return rows


async def run_scorecard_pass(db: AsyncSession) -> str:
    """Full scorecard computation pass. Deletes old rows and inserts fresh ones.

    Called from the arq cron at 00:00 UTC. Uses statement_timeout as per R4
    (RAM VPS 3.7 GB) to avoid long-running queries during the nightly window.
    """
    from app.config import settings

    if not settings.SCORECARD_ENABLED:
        return "[scorecard] disabled (SCORECARD_ENABLED=0)"

    try:
        # Statement timeout for the nightly query (R4: 660 MB free — a runaway
        # scan here competes with production Postgres). `set_config(..., true)`
        # is the parameterisable form of SET LOCAL; plain `SET` takes no bind
        # parameters. It is transaction-local, so open one explicitly rather
        # than relying on whatever the caller's session was doing.
        if db.get_bind().dialect.name == "postgresql":
            if not db.in_transaction():
                await db.begin()
            await db.execute(
                text("SELECT set_config('statement_timeout', :t, true)").bindparams(
                    t=settings.SCORECARD_STATEMENT_TIMEOUT
                )
            )

        rows = await compute_scorecard(db, window_days=settings.SCORECARD_WINDOW_DAYS)

        # Delete old scorecard rows and insert new ones (atomic replace)
        await db.execute(delete(SourceScorecard))
        for row in rows:
            db.add(row)
        await db.commit()

        total_n = sum(r.n for r in rows)
        sufficient = sum(1 for r in rows if r.n >= EVIDENCE_MIN_N)
        return (
            f"[scorecard] computed={len(rows)} "
            f"total_signals_matched={total_n} sufficient={sufficient}"
        )
    except Exception:
        logger.exception("scorecard pass failed")
        await db.rollback()
        return "[scorecard] error"


async def get_scorecard_for_source(
    db: AsyncSession,
    *,
    source: str,
    horizon: str | None = None,
) -> list[SourceScorecard]:
    """Read scorecard rows for a source, optionally filtered by horizon."""
    q = select(SourceScorecard).where(SourceScorecard.source == source)
    if horizon:
        q = q.where(SourceScorecard.horizon == horizon)
    q = q.order_by(SourceScorecard.computed_at.desc())
    return list((await db.execute(q)).scalars().all())


async def evidence_table_for(
    db: AsyncSession,
) -> dict[tuple[str, str], tuple[int, float | None, float | None, int]]:
    """One query, folded to `(source, horizon) -> (n, hit_rate, avg_r, window)`.

    The stored rows are per-regime; the Ideas feed asks a coarser question
    ("does this source work at all on this horizon"), so regimes are collapsed
    here by n-weighting. Regime-sliced numbers stay available to Lab through
    `list_scorecard`, which reads the rows as stored.
    """
    rows = list((await db.execute(select(SourceScorecard))).scalars().all())

    acc: dict[tuple[str, str], list[float | int]] = {}
    for row in rows:
        key = (row.source, row.horizon)
        # [n, sum(hit_rate*n), sum(avg_r*n), window_days]
        bucket = acc.setdefault(key, [0, 0.0, 0.0, row.window_days])
        bucket[0] += row.n
        bucket[1] += (row.hit_rate or 0.0) * row.n
        bucket[2] += (row.avg_r or 0.0) * row.n

    out: dict[tuple[str, str], tuple[int, float | None, float | None, int]] = {}
    for key, (n, hr_sum, r_sum, window) in acc.items():
        n = int(n)
        out[key] = (
            n,
            (hr_sum / n) if n else None,
            (r_sum / n) if n else None,
            int(window),
        )
    return out


async def list_scorecard(db: AsyncSession, *, source: str | None = None) -> list[SourceScorecard]:
    """Every stored row, regime slices intact — what Lab renders."""
    q = select(SourceScorecard)
    if source:
        q = q.where(SourceScorecard.source == source)
    q = q.order_by(
        SourceScorecard.source,
        SourceScorecard.horizon,
        SourceScorecard.n.desc(),
    )
    return list((await db.execute(q)).scalars().all())


async def get_evidence_for_opportunity(
    db: AsyncSession,
    *,
    source: str,
    horizon: str,
) -> dict:
    """Returns evidence dict suitable for the Opportunity read model.
    This is called by the opportunities service to fill real evidence
    instead of the hardcoded 'insufficient' from Sprint 2.
    """
    rows = await get_scorecard_for_source(db, source=source, horizon=horizon)
    if not rows:
        return {
            "status": "insufficient",
            "n": 0,
            "hit_rate": None,
            "avg_r": None,
            "window_days": 30,
        }

    # Aggregate across regimes for a source+horizon
    total_n = sum(r.n for r in rows)
    if total_n < EVIDENCE_MIN_N:
        return {
            "status": "insufficient",
            "n": total_n,
            "hit_rate": None,
            "avg_r": None,
            "window_days": 30,
        }

    # Weighted averages
    weighted_hr = sum((r.hit_rate or 0) * r.n for r in rows if r.n > 0) / total_n
    weighted_avg_r = sum((r.avg_r or 0) * r.n for r in rows if r.n > 0) / total_n

    return {
        "status": "ok",
        "n": total_n,
        "hit_rate": round(weighted_hr, 4),
        "avg_r": round(weighted_avg_r, 4),
        "window_days": rows[0].window_days,
    }
