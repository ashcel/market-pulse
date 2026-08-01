from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.execution.alert_models import AlertSeverity, AlertType
from app.execution.alert_service import (
    AlertCandidate,
    BehaviorCooldownAlert,
    CatalystAlert,
    EntryZoneAlert,
    InvalidationAlert,
    PositionRiskAlert,
    VerdictChangeAlert,
    create_alerts,
    danger_window,
)
from app.config import settings

from .binance import fetch_price


def _number(snapshot: dict[str, Any], key: str) -> float | None:
    try:
        return float(snapshot[key])
    except (KeyError, TypeError, ValueError):
        return None


async def _watched_decisions(db: AsyncSession) -> list[dict[str, Any]]:
    result = await db.execute(
        text(
            "select distinct on (user_id, symbol) id, user_id, symbol, side,"
            " proposal_snapshot, account_state_snapshot, created_at from trade_permits"
            " where status = 'APPROVED' order by user_id, symbol, created_at desc"
        )
    )
    return [dict(row) for row in result.mappings()]


async def _market_candidates(decisions: list[dict[str, Any]]) -> list[AlertCandidate]:
    candidates: list[AlertCandidate] = []
    for decision in decisions:
        symbol = str(decision["symbol"]).upper()
        snapshot = decision["proposal_snapshot"] or {}
        price = await fetch_price(symbol, "perp")
        entry = _number(snapshot, "entry_price")
        stop = _number(snapshot, "stop_price")
        if price is not None and entry is not None:
            tolerance = max(abs(entry) * 0.0025, 1e-12)
            if abs(price - entry) <= tolerance:
                candidates.append(
                    EntryZoneAlert(
                        user_id=decision["user_id"],
                        type=AlertType.ENTRY_ZONE,
                        token_symbol=symbol,
                        title=f"{symbol} entered your entry zone",
                        body=f"Current price {price:g} is near saved entry {entry:g}.",
                        severity=AlertSeverity.INFO,
                        dedupe_key=f"entry:{decision['id']}",
                        source_decision_id=decision["id"],
                    )
                )
        side = str(decision["side"]).upper()
        broken = (
            price is not None
            and stop is not None
            and (
                (side in {"BUY", "LONG"} and price <= stop)
                or (side in {"SELL", "SHORT"} and price >= stop)
            )
        )
        if broken:
            candidates.append(
                InvalidationAlert(
                    user_id=decision["user_id"],
                    type=AlertType.INVALIDATION,
                    token_symbol=symbol,
                    title=f"{symbol} invalidation broken",
                    body=f"Price {price:g} crossed saved stop {stop:g}.",
                    severity=AlertSeverity.CRITICAL,
                    dedupe_key=f"invalidation:{decision['id']}",
                    source_decision_id=decision["id"],
                )
            )
        flags = sorted((decision["account_state_snapshot"] or {}).get("active_behavior_flags", []))
        if flags:
            candidates.append(
                BehaviorCooldownAlert(
                    user_id=decision["user_id"],
                    type=AlertType.BEHAVIOR_COOLDOWN,
                    token_symbol=symbol,
                    title="Trading cooldown active",
                    body=f"Behavior guard detected: {', '.join(flags)}.",
                    severity=AlertSeverity.WARNING,
                    dedupe_key=f"behavior:{decision['id']}:{','.join(flags)}",
                    source_decision_id=decision["id"],
                )
            )
    return candidates


async def _database_candidates(
    db: AsyncSession, decisions: list[dict[str, Any]], now: datetime
) -> list[AlertCandidate]:
    candidates: list[AlertCandidate] = []
    for decision in decisions:
        symbol = str(decision["symbol"]).upper()
        evals = (
            (
                await db.execute(
                    text(
                        "select id, verdict, direction from eval_log where symbol = :symbol"
                        " order by evaluated_at desc limit 2"
                    ),
                    {"symbol": symbol},
                )
            )
            .mappings()
            .all()
        )
        if len(evals) == 2 and (evals[0]["verdict"], evals[0]["direction"]) != (
            evals[1]["verdict"],
            evals[1]["direction"],
        ):
            candidates.append(
                VerdictChangeAlert(
                    user_id=decision["user_id"],
                    type=AlertType.VERDICT_CHANGE,
                    token_symbol=symbol,
                    title=f"{symbol} verdict changed",
                    body=(
                        f"{evals[1]['verdict']} -> {evals[0]['verdict']} "
                        f"({evals[0]['direction'] or 'neutral'})."
                    ),
                    severity=AlertSeverity.WARNING,
                    dedupe_key=f"verdict:{decision['user_id']}:{evals[0]['id']}",
                    source_decision_id=decision["id"],
                )
            )
        events = (
            (
                await db.execute(
                    text(
                        "select id, title, occurs_at from catalyst_event where symbol = :symbol"
                        " and occurs_at >= :now and occurs_at <= :until order by occurs_at"
                    ),
                    {"symbol": symbol, "now": now, "until": danger_window(now)},
                )
            )
            .mappings()
            .all()
        )
        for event in events:
            candidates.append(
                CatalystAlert(
                    user_id=decision["user_id"],
                    type=AlertType.CATALYST,
                    token_symbol=symbol,
                    title=f"{symbol} catalyst danger window",
                    body=(
                        f"{event['title']} occurs within 24 hours for your "
                        f"{decision['side']} decision."
                    ),
                    severity=AlertSeverity.WARNING,
                    dedupe_key=f"catalyst:{decision['id']}:{event['id']}",
                    source_decision_id=decision["id"],
                )
            )
    return candidates


_BULLISH_MARKERS = ("bull", "up", "risk-on", "risk_on")
_BEARISH_MARKERS = ("bear", "down", "risk-off", "risk_off")


def _regime_direction(regime: str | None) -> str | None:
    """Return a tradable direction only when the regime label is unambiguous."""
    if not regime:
        return None
    label = regime.lower()
    bullish = any(marker in label for marker in _BULLISH_MARKERS)
    bearish = any(marker in label for marker in _BEARISH_MARKERS)
    if bullish == bearish:
        return None
    return "LONG" if bullish else "SHORT"


async def _open_execution_positions(db: AsyncSession) -> list[dict[str, Any]]:
    """MP-owned executed positions only; Tradeway positions are never read here."""
    result = await db.execute(
        text(
            "select id, user_id, symbol, side, stop_price from execution_records "
            "where flattened = false and filled_quantity > 0 "
            "and status in ('PROTECTED', 'TP_FAILED')"
        )
    )
    return [dict(row) for row in result.mappings()]


async def _position_risk_candidates(
    db: AsyncSession, positions: list[dict[str, Any]], now: datetime
) -> list[AlertCandidate]:
    candidates: list[AlertCandidate] = []
    seen_flips: set[str] = set()
    seen_prices: dict[str, float | None] = {}

    for position in positions:
        symbol = str(position["symbol"]).upper()
        price = seen_prices.get(symbol)
        if symbol not in seen_prices:
            price = await fetch_price(symbol, "perp")
            seen_prices[symbol] = price

        stop = _number(position, "stop_price")
        if price is not None and stop is not None and stop > 0:
            distance = abs(price - stop) / abs(stop)
            if distance <= 0.005:
                candidates.append(
                    PositionRiskAlert(
                        user_id=str(position["user_id"]),
                        type=AlertType.POSITION_RISK,
                        token_symbol=symbol,
                        title=f"Stop {symbol} sudah dekat",
                        body=f"Harga {price:g} berjarak {distance:.2%} dari stop {stop:g}.",
                        severity=AlertSeverity.CRITICAL,
                        dedupe_key=f"stop_near|{position['id']}|{now:%Y-%m-%d}",
                        source_decision_id=None,
                    )
                )

        regimes = (
            (
                await db.execute(
                    text(
                        "select regime from eval_log where symbol = :symbol "
                        "order by evaluated_at desc limit 2"
                    ),
                    {"symbol": symbol},
                )
            )
            .mappings()
            .all()
        )
        if len(regimes) != 2:
            continue
        to_regime, from_regime = str(regimes[0]["regime"]), str(regimes[1]["regime"])
        to_direction, from_direction = _regime_direction(to_regime), _regime_direction(from_regime)
        position_side = str(position["side"]).upper()
        if (
            to_direction is None
            or from_direction is None
            or to_direction == from_direction
            or position_side != ("SHORT" if to_direction == "LONG" else "LONG")
        ):
            continue
        key = f"regime_flip|{position['user_id']}|{from_regime}->{to_regime}|{now:%Y-%m-%d-%H}"
        if key in seen_flips:
            continue
        seen_flips.add(key)
        candidates.append(
            PositionRiskAlert(
                user_id=str(position["user_id"]),
                type=AlertType.POSITION_RISK,
                token_symbol=symbol,
                title=f"Regime berbalik melawan posisi {symbol}",
                body=(
                    f"Regime berubah dari {from_regime} ke {to_regime}, "
                    f"sementara posisi {position_side} masih terbuka."
                ),
                severity=AlertSeverity.CRITICAL,
                dedupe_key=key,
                source_decision_id=None,
            )
        )
    return candidates


async def run_alert_pass(db: AsyncSession) -> int:
    now = datetime.now(UTC)
    decisions = await _watched_decisions(db)
    market = await _market_candidates(decisions)
    database = await _database_candidates(db, decisions, now)
    position_risk: list[AlertCandidate] = []
    if settings.POSITION_RISK_ALERTS:
        position_risk = await _position_risk_candidates(db, await _open_execution_positions(db), now)
    return await create_alerts(db, market + database + position_risk)
