from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import bindparam, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.config import settings
from app.events.service import build_catalyst_event_response
from app.execution.account_service import AccountStateError, get_account_state
from app.execution.config import execution_settings
from app.forward_test.models import EvalLog


class UniverseVerdict(BaseModel):
    symbol: str
    objective: str
    state: Literal["go", "wait", "no_go"]
    direction: str | None
    confidence: float
    verdict: str
    invalidated_by: str
    what_flips_it: str


class UniverseCatalyst(BaseModel):
    symbol: str
    events: list[dict[str, Any]]
    impact_score: float
    modifier: str
    freshness: str


class UniverseAccount(BaseModel):
    status: str
    buying_power: float
    open_positions: int
    freshness: str


class UniverseMarketState(BaseModel):
    regime: str
    regime_confidence: float
    trend: str


class UniverseMeta(BaseModel):
    engine_version: str
    snapshot_age_ms: int


class UniverseSnapshot(BaseModel):
    snapshot_timestamp: datetime
    verdicts: list[UniverseVerdict]
    catalysts: list[UniverseCatalyst]
    account: UniverseAccount
    market_state: UniverseMarketState
    meta: UniverseMeta


def _state(verdict: str) -> Literal["go", "wait", "no_go"]:
    if verdict == "favored":
        return "go"
    if verdict == "caution":
        return "wait"
    return "no_go"


def _trend(regime: str) -> str:
    if "up" in regime or regime == "bullish":
        return "uptrend"
    if "down" in regime or regime == "bearish":
        return "downtrend"
    return "sideways"


async def build_universe(db: AsyncSession, user_id: str) -> UniverseSnapshot:
    snapshot_at = datetime.now(UTC)
    ranked = (
        select(
            EvalLog.id.label("id"),
            func.row_number()
            .over(
                partition_by=(EvalLog.symbol, EvalLog.market, EvalLog.intent),
                order_by=EvalLog.evaluated_at.desc(),
            )
            .label("rank"),
        )
        .where(EvalLog.market == "spot")
        .subquery()
    )
    latest = aliased(EvalLog)
    result = await db.execute(
        select(latest)
        .join(ranked, latest.id == ranked.c.id)
        .where(ranked.c.rank == 1)
        .order_by(latest.symbol, latest.intent)
    )
    rows = list(result.scalars())

    verdicts = []
    for row in rows:
        reasons = row.no_trade_reasons or []
        reason = reasons[0] if reasons else "Setup remains valid while structure holds."
        verdicts.append(
            UniverseVerdict(
                symbol=row.symbol,
                objective=row.intent,
                state=_state(row.verdict),
                direction=row.direction,
                confidence=row.confidence or 0.0,
                verdict=row.verdict,
                invalidated_by=reason,
                what_flips_it=reason,
            )
        )

    symbols = sorted({row.symbol for row in rows})
    event_symbols = [symbol.removesuffix("USDT") for symbol in symbols]
    event_rows: dict[str, list[Any]] = {symbol: [] for symbol in event_symbols}
    if event_symbols:
        event_result = await db.execute(
            text(
                "select * from catalyst_event where symbol in :symbols"
                " and occurs_at >= now() and occurs_at <= :until order by occurs_at asc"
            ).bindparams(bindparam("symbols", expanding=True)),
            {"symbols": event_symbols, "until": snapshot_at + timedelta(days=7)},
        )
        for event_row in event_result.mappings():
            event_rows[event_row["symbol"]].append(
                build_catalyst_event_response(event_row, snapshot_at)
            )

    catalysts = []
    for symbol in symbols:
        events = event_rows[symbol.removesuffix("USDT")]
        score = max((event.impact_score for event in events), default=0.0)
        direction = (
            max(events, key=lambda event: event.impact_score).direction if events else "neutral"
        )
        catalysts.append(
            UniverseCatalyst(
                symbol=symbol,
                events=[event.model_dump(mode="json") for event in events],
                impact_score=score,
                modifier=direction,
                freshness="ok",
            )
        )

    try:
        state = await get_account_state(db, user_id, execution_settings)
        account = UniverseAccount(
            status="ok",
            buying_power=float(state.balance),
            open_positions=state.open_position_count,
            freshness="stale" if state.is_stale else "fresh",
        )
    except AccountStateError:
        account = UniverseAccount(
            status="unavailable", buying_power=0.0, open_positions=0, freshness="unavailable"
        )

    newest = max((row.evaluated_at for row in rows), default=snapshot_at)
    if newest.tzinfo is None:
        newest = newest.replace(tzinfo=UTC)
    representative = max(rows, key=lambda row: row.confidence or 0.0) if rows else None
    regime = representative.regime if representative else "neutral"
    return UniverseSnapshot(
        snapshot_timestamp=snapshot_at,
        verdicts=verdicts,
        catalysts=catalysts,
        account=account,
        market_state=UniverseMarketState(
            regime=regime,
            regime_confidence=(representative.confidence or 0.0) if representative else 0.0,
            trend=_trend(regime),
        ),
        meta=UniverseMeta(
            engine_version=(
                representative.engine_version if representative else settings.APP_VERSION
            ),
            snapshot_age_ms=max(0, int((snapshot_at - newest).total_seconds() * 1000)),
        ),
    )
