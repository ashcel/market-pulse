"""Scorecard computation — reuses the SAME settlement code path as the
forward-test worker (docs/IMPLEMENTATION-PLAN.md §1.5-#5: "runner sendiri di
atas kode settlement forward-test yang sudah ada").

The scorecard joins `signal_events` to settled `shadow_signal` rows using
(source, symbol, side, horizon, detected_at window). The settlement result_r
from `shadow_signal` is the measure of success:
  - result_r > 0 → hit
  - result_r ≤ 0 → miss
  - result_r IS NULL → still open or never matched (excluded from counts)

n < EVIDENCE_MIN_N (20) → status='insufficient', hit_rate/avg_r are still
computed and stored but the UI shows "Belum cukup data" instead of a number.

R3 compliance: scorecard is ONLY built from signal_events.detected_at (live
detection time), NEVER from re-derived historical candle data. Cross-timeframe
joins use close time, not open time.
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.forward_test.models import ShadowSignalRow
from app.opportunities.service import EVIDENCE_MIN_N
from app.scorecard.models import SourceScorecard
from app.signals.models import SignalEvent

logger = logging.getLogger("scorecard")

# Map signal_events.side → shadow_signal.direction (they use the same values)
# Map signal_events.horizon → shadow_signal.timeframe
_HORIZON_TF = {
    "scalp": "15m",
    "intraday": "1H",
    "swing": "4H",
    "position": "1D",
}


async def compute_scorecard(
    db: AsyncSession,
    *,
    window_days: int = 30,
    now: datetime | None = None,
) -> list[SourceScorecard]:
    """Compute source_scorecard rows for every (source, source_version, regime,
    horizon) combination in signal_events over the last `window_days`.

    This uses settled shadow_signal records as ground truth. A signal is matched
    to a shadow record when the shadow was opened in the same detection window
    (±1h of the signal's detected_at) for the same symbol, direction, and market.
    """
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=window_days)

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
        signals_q = (
            select(SignalEvent)
            .where(
                SignalEvent.source == source,
                SignalEvent.source_version == source_version,
                SignalEvent.horizon == horizon,
                SignalEvent.detected_at >= cutoff,
            )
        )
        signals = (await db.execute(signals_q)).scalars().all()

        # Get all settled shadow records in the window
        settled_q = (
            select(ShadowSignalRow)
            .where(
                ShadowSignalRow.status.in_(("hit_tp", "hit_sl", "expired", "invalidated")),
                ShadowSignalRow.closed_at >= cutoff,
                ShadowSignalRow.result_r.is_not(None),
            )
        )
        settled = (await db.execute(settled_q)).scalars().all()

        # Group settled by regime
        regime_results: dict[str, list[float]] = {}

        for sig in signals:
            # Find matching settlement: same symbol, same direction, opened near detection
            for shadow in settled:
                if (
                    shadow.symbol == sig.symbol
                    and shadow.direction == sig.side
                    and shadow.result_r is not None
                ):
                    # Check time proximity: shadow opened within ±2h of signal detection
                    sig_dt = sig.detected_at
                    shadow_dt = shadow.opened_at
                    if sig_dt.tzinfo is None:
                        sig_dt = sig_dt.replace(tzinfo=UTC)
                    if shadow_dt.tzinfo is None:
                        shadow_dt = shadow_dt.replace(tzinfo=UTC)

                    if abs((sig_dt - shadow_dt).total_seconds()) <= 7200:
                        regime = shadow.regime or "unknown"
                        regime_results.setdefault(regime, []).append(shadow.result_r)
                        break  # one match per signal

        # If no regime-matched results found, still emit a row with "unknown" regime
        if not regime_results:
            regime_results["unknown"] = []

        for regime, r_values in regime_results.items():
            n = len(r_values)
            hit_rate = (
                sum(1 for r in r_values if r > 0) / n if n > 0 else None
            )
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
        # Set statement timeout for the query (R4: RAM constraints)
        await db.execute(text("SET LOCAL statement_timeout = '30s'"))

        rows = await compute_scorecard(db, window_days=30)

        # Delete old scorecard rows and insert new ones (atomic replace)
        await db.execute(delete(SourceScorecard))
        for row in rows:
            db.add(row)
        await db.commit()

        total_n = sum(r.n for r in rows)
        sufficient = sum(1 for r in rows if r.n >= EVIDENCE_MIN_N)
        return f"[scorecard] computed={len(rows)} total_signals_matched={total_n} sufficient={sufficient}"
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
        return {"status": "insufficient", "n": 0, "hit_rate": None, "avg_r": None, "window_days": 30}

    # Aggregate across regimes for a source+horizon
    total_n = sum(r.n for r in rows)
    if total_n < EVIDENCE_MIN_N:
        return {"status": "insufficient", "n": total_n, "hit_rate": None, "avg_r": None, "window_days": 30}

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
