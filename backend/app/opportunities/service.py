"""Opportunities — a READ MODEL over `signal_events` (§2.3 of
docs/IMPLEMENTATION-PLAN.md). Nothing here is ever written to a table.

Grouping: one card per `(symbol, side, horizon, calendar day)`. Several
detectors firing on the same symbol/side/day are one opportunity with several
sources — "2 sumber sepakat" is the signal, not two cards competing for the
same attention.

Regime is a *ranking* input, not a filter. A counter-regime idea sinks to the
bottom carrying `regime_alignment='counter'`; it is never hidden, because
hiding it would be pretending we did not see it.

Evidence is honest by construction: until the Sprint 5 scorecard exists there
is no hit-rate to report, so `status='insufficient'` and the numbers stay
None. Never invent a percentage — R3 is precisely about numbers that look
earned and are not.
"""

import math
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.config import settings
from app.forward_test.models import EvalLog
from app.signals.models import SignalEvent
from app.signals.repo import list_signals

# --- contract ------------------------------------------------------------


class OpportunitySource(BaseModel):
    source: str
    source_version: str
    kind: str
    conviction: str | None
    detected_at: datetime
    reason: str  # one line, Indonesian, display-ready


class Evidence(BaseModel):
    status: Literal["ok", "insufficient"]
    n: int
    hit_rate: float | None
    avg_r: float | None
    window_days: int = 30


class Opportunity(BaseModel):
    key: str  # '{symbol}|{side}|{horizon}|{YYYY-MM-DD}'
    symbol: str
    side: str
    horizon: str
    sources: list[OpportunitySource]
    conviction: Literal["low", "medium", "high"]
    regime_alignment: Literal["aligned", "counter", "neutral"]
    rank_score: float
    evidence: Evidence
    first_detected_at: datetime
    last_detected_at: datetime
    expires_at: datetime | None


# --- ranking (deterministic, written down, not held in anyone's head) -----

CONVICTION_WEIGHT = {"low": 0.4, "medium": 0.7, "high": 1.0, "very_high": 1.2}
REGIME_FACTOR = {"aligned": 1.0, "neutral": 0.8, "counter": 0.4}
_MULTI_SOURCE_BONUS = 0.35
_FRESHNESS_HALFLIFE_H = 12.0
# Below this the scorecard cannot claim anything; shown as "Belum cukup data".
EVIDENCE_MIN_N = 20

# Written by different sources with different spellings; normalised on read so
# the weight table has one key per tier.
_CONVICTION_ALIASES = {"very-high": "very_high", "veryhigh": "very_high"}
_CONVICTION_ORDER = ["low", "medium", "high", "very_high"]


def normalize_conviction(value: str | None) -> str | None:
    if not value:
        return None
    key = _CONVICTION_ALIASES.get(value.strip().lower(), value.strip().lower())
    return key if key in CONVICTION_WEIGHT else None


def freshness(last_detected_at: datetime, now: datetime) -> float:
    hours = max(0.0, (now - last_detected_at).total_seconds() / 3600.0)
    return math.exp(-hours / _FRESHNESS_HALFLIFE_H)


def rank_score(
    *,
    conviction: str | None,
    source_count: int,
    last_detected_at: datetime,
    regime_alignment: str,
    now: datetime,
) -> float:
    weight = CONVICTION_WEIGHT.get(normalize_conviction(conviction) or "", CONVICTION_WEIGHT["low"])
    agreement = 1 + _MULTI_SOURCE_BONUS * (max(1, source_count) - 1)
    return (
        weight
        * agreement
        * freshness(last_detected_at, now)
        * REGIME_FACTOR.get(regime_alignment, REGIME_FACTOR["neutral"])
    )


# --- regime gate ---------------------------------------------------------

_BULLISH_MARKERS = ("bull", "up", "risk-on", "risk_on")
_BEARISH_MARKERS = ("bear", "down", "risk-off", "risk_off")


def regime_alignment_for(regime: str | None, side: str) -> Literal["aligned", "counter", "neutral"]:
    """Map a regime label onto a side. Anything that is neither clearly bullish
    nor clearly bearish (choppy, ranging, unknown, missing) is 'neutral' — an
    absent regime must never be dressed up as agreement."""
    if not regime:
        return "neutral"
    label = regime.strip().lower()
    bullish = any(marker in label for marker in _BULLISH_MARKERS)
    bearish = any(marker in label for marker in _BEARISH_MARKERS)
    if bullish == bearish:  # both or neither: no usable direction
        return "neutral"
    direction = "long" if bullish else "short"
    return "aligned" if side.lower() == direction else "counter"


async def _latest_regime_by_symbol(db: AsyncSession, symbols: list[str]) -> dict[str, str]:
    """Latest engine regime per symbol, from the same `eval_log` rows the
    universe snapshot reads (`app/market/batch_service.py`) — one regime
    source, not a second opinion invented here."""
    if not symbols:
        return {}
    ranked = (
        select(
            EvalLog.id.label("id"),
            func.row_number()
            .over(partition_by=EvalLog.symbol, order_by=EvalLog.evaluated_at.desc())
            .label("rank"),
        )
        .where(EvalLog.symbol.in_(symbols))
        .subquery()
    )
    latest = aliased(EvalLog)
    rows = await db.execute(
        select(latest.symbol, latest.regime)
        .join(ranked, latest.id == ranked.c.id)
        .where(ranked.c.rank == 1)
    )
    return {symbol: regime for symbol, regime in rows.all()}


# --- assembly ------------------------------------------------------------

_SIDE_ID = {"long": "naik", "short": "turun"}
_CONVICTION_ID = {
    "low": "rendah",
    "medium": "sedang",
    "high": "tinggi",
    "very_high": "sangat tinggi",
}


def _reason(event: SignalEvent) -> str:
    """One display-ready Indonesian line (plan §1 rule 8: product text is
    Indonesian, internals stay English). No jargon leaks: the detector id is
    shown as-is because it is a name, not a term to decode."""
    arah = _SIDE_ID.get(event.side.lower(), event.side)
    conviction = normalize_conviction(event.conviction)
    keyakinan = _CONVICTION_ID.get(conviction or "")
    tail = f", keyakinan {keyakinan}" if keyakinan else ""
    return f"{event.source} melihat {event.kind} arah {arah}{tail}"


def _display_conviction(best: str | None) -> Literal["low", "medium", "high"]:
    # very_high still ranks at 1.2 above; the card only has three labels, so it
    # displays as 'high' rather than inventing a fourth badge.
    if best == "very_high":
        return "high"
    if best in ("low", "medium", "high"):
        return best  # type: ignore[return-value]
    return "low"


def _group_key(event: SignalEvent, day: date) -> str:
    return f"{event.symbol}|{event.side}|{event.horizon}|{day.isoformat()}"


def evidence_for(
    sources: set[str],
    horizon: str,
    table: dict[tuple[str, str], tuple[int, float | None, float | None, int]] | None,
) -> Evidence:
    """Fold the scorecard rows for a card's sources into one Evidence.

    n-weighted, because a source with 80 settled signals should move the number
    more than one with 3. Below EVIDENCE_MIN_N the numbers are dropped entirely
    rather than shown small — a hit-rate off 4 samples reads as earned and is
    not (R3). Absent scorecard (flag off, cron not yet run) is the same answer.
    """
    if not table:
        return Evidence(status="insufficient", n=0, hit_rate=None, avg_r=None, window_days=30)

    rows = [table[(source, horizon)] for source in sources if (source, horizon) in table]
    total_n = sum(row[0] for row in rows)
    if total_n < EVIDENCE_MIN_N:
        return Evidence(
            status="insufficient",
            n=total_n,
            hit_rate=None,
            avg_r=None,
            window_days=rows[0][3] if rows else 30,
        )

    hit_rate = sum((row[1] or 0.0) * row[0] for row in rows) / total_n
    avg_r = sum((row[2] or 0.0) * row[0] for row in rows) / total_n
    return Evidence(
        status="ok",
        n=total_n,
        hit_rate=round(hit_rate, 4),
        avg_r=round(avg_r, 4),
        window_days=rows[0][3],
    )


def build_opportunities(
    events: list[SignalEvent],
    *,
    regimes: dict[str, str],
    now: datetime,
    limit: int = 20,
    evidence_table: dict[tuple[str, str], tuple[int, float | None, float | None, int]]
    | None = None,
) -> list[Opportunity]:
    groups: dict[str, list[SignalEvent]] = defaultdict(list)
    for event in events:
        detected = event.detected_at
        if detected.tzinfo is None:
            detected = detected.replace(tzinfo=UTC)
        groups[_group_key(event, detected.astimezone(UTC).date())].append(event)

    cards: list[Opportunity] = []
    for key, rows in groups.items():
        ordered = sorted(rows, key=lambda row: _aware(row.detected_at))
        head = ordered[0]
        first_at = _aware(ordered[0].detected_at)
        last_at = _aware(ordered[-1].detected_at)

        convictions = [normalize_conviction(row.conviction) for row in ordered]
        best = max(
            (c for c in convictions if c),
            key=lambda c: _CONVICTION_ORDER.index(c),
            default=None,
        )
        # Distinct sources, not distinct detectors: three detectors inside one
        # app agreeing is one opinion, and the agreement bonus must not pay out
        # for it.
        distinct_sources = {row.source for row in ordered}
        alignment = regime_alignment_for(regimes.get(head.symbol), head.side)

        expiries = [_aware(row.expires_at) for row in ordered if row.expires_at]
        cards.append(
            Opportunity(
                key=key,
                symbol=head.symbol,
                side=head.side,
                horizon=head.horizon,
                sources=[
                    OpportunitySource(
                        source=row.source,
                        source_version=row.source_version,
                        kind=row.kind,
                        conviction=normalize_conviction(row.conviction),
                        detected_at=_aware(row.detected_at),
                        reason=_reason(row),
                    )
                    for row in ordered
                ],
                conviction=_display_conviction(best),
                regime_alignment=alignment,
                rank_score=rank_score(
                    conviction=best,
                    source_count=len(distinct_sources),
                    last_detected_at=last_at,
                    regime_alignment=alignment,
                    now=now,
                ),
                # Filled from source_scorecard (Sprint 5). With the flag off or
                # the cron not yet run the table is empty and this stays
                # 'insufficient' — no n, so no percentage (R3).
                evidence=evidence_for(distinct_sources, head.horizon, evidence_table),
                first_detected_at=first_at,
                last_detected_at=last_at,
                expires_at=min(expiries) if expiries else None,
            )
        )

    cards.sort(key=lambda card: (-card.rank_score, card.symbol))
    return cards[:limit]


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


async def list_opportunities(
    db: AsyncSession,
    *,
    horizon: str | None = None,
    limit: int = 20,
    lookback_days: int = 2,
    now: datetime | None = None,
) -> list[Opportunity]:
    now = now or datetime.now(UTC)
    events = await list_signals(
        db,
        since=now - timedelta(days=lookback_days),
        sources=list(settings.SIGNAL_SOURCES_LIVE) or None,
        # Shadow rows are recorded but never surfaced: a source proves itself
        # in `source_scorecard` before it reaches the Ideas feed.
        status="live",
        horizon=horizon,
    )
    regimes = await _latest_regime_by_symbol(db, sorted({event.symbol for event in events}))
    # Imported here, not at module scope: app.scorecard.service imports
    # EVIDENCE_MIN_N from this module.
    from app.scorecard.service import evidence_table_for

    table = await evidence_table_for(db) if settings.SCORECARD_ENABLED else None
    return build_opportunities(events, regimes=regimes, now=now, limit=limit, evidence_table=table)
