"""Sprint 4 position-risk rules stay deterministic and default-off."""

from datetime import UTC, datetime
from typing import Any

import pytest

from app.config import settings
from app.delivery.service import run_delivery_pass
from app.execution.alert_models import Alert, AlertSeverity, AlertType
from app.execution.alert_service import create_alerts
from app.worker import alert_pass


class _Mappings:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def all(self) -> list[dict[str, Any]]:
        return self.rows


class _Result:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def mappings(self) -> _Mappings:
        return _Mappings(self.rows)


class _RegimeDb:
    def __init__(self, regimes: list[str]) -> None:
        self.regimes = regimes

    async def execute(self, _statement: Any, _params: Any = None) -> _Result:
        return _Result([{"regime": regime} for regime in self.regimes])


POSITION = {"id": "position-1", "user_id": "user-1", "symbol": "BTCUSDT", "side": "SHORT", "stop_price": 100.0}
NOW = datetime(2026, 8, 1, 12, tzinfo=UTC)


@pytest.mark.asyncio
async def test_regime_flip_against_open_position_fires_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(alert_pass, "fetch_price", lambda *_args: _value(110.0))
    candidates = await alert_pass._position_risk_candidates(_RegimeDb(["bull", "bear"]), [POSITION], NOW)
    flips = [candidate for candidate in candidates if candidate.dedupe_key.startswith("regime_flip|")]

    assert len(flips) == 1
    assert flips[0].type == AlertType.POSITION_RISK
    assert flips[0].severity == AlertSeverity.CRITICAL
    assert flips[0].dedupe_key == "regime_flip|user-1|bear->bull|2026-08-01-12"

    db = _AlertDb()
    # Multiple open positions may produce the same user/flip key in one pass.
    assert await create_alerts(db, [flips[0], flips[0]]) == 1
    assert await create_alerts(db, flips) == 0


@pytest.mark.asyncio
async def test_no_directional_flip_creates_no_position_risk_alert(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(alert_pass, "fetch_price", lambda *_args: _value(110.0))
    candidates = await alert_pass._position_risk_candidates(_RegimeDb(["bull", "bullish"]), [POSITION], NOW)
    assert candidates == []


@pytest.mark.asyncio
async def test_stop_near_alert_is_once_per_position_per_day(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(alert_pass, "fetch_price", lambda *_args: _value(100.4))
    candidates = await alert_pass._position_risk_candidates(_RegimeDb([]), [POSITION], NOW)
    stops = [candidate for candidate in candidates if candidate.dedupe_key.startswith("stop_near|")]
    assert len(stops) == 1
    assert stops[0].severity == AlertSeverity.CRITICAL

    db = _AlertDb()
    assert await create_alerts(db, stops) == 1
    assert await create_alerts(db, stops) == 0


@pytest.mark.asyncio
async def test_critical_position_risk_ignores_quiet_hours(monkeypatch: pytest.MonkeyPatch) -> None:
    alert = Alert(
        user_id="user-1", type=AlertType.POSITION_RISK.value, token_symbol="BTCUSDT",
        title="Risiko posisi", body="Stop dekat", severity=AlertSeverity.CRITICAL.value,
        dedupe_key="critical-quiet-hours",
    )
    db = _DeliveryDb(alert)
    monkeypatch.setattr(settings, "DELIVERY_ENABLED", True)
    monkeypatch.setattr("app.delivery.service._in_quiet_hours", lambda _now: True)
    monkeypatch.setattr("app.delivery.service.send_telegram", lambda *_args, **_kwargs: _value(True))

    assert await run_delivery_pass(db) == 1
    assert alert.delivery_state == "sent"
    assert "https://iq.heydewi.com/book" in alert_pass_text(alert)


@pytest.mark.asyncio
async def test_position_risk_flag_off_does_not_read_or_create_risk_alerts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "POSITION_RISK_ALERTS", False)
    monkeypatch.setattr(alert_pass, "_watched_decisions", lambda _db: _value([]))
    monkeypatch.setattr(alert_pass, "_market_candidates", lambda _decisions: _value([]))
    monkeypatch.setattr(alert_pass, "_database_candidates", lambda *_args: _value([]))
    monkeypatch.setattr(alert_pass, "_open_execution_positions", lambda _db: _raise_if_called())
    monkeypatch.setattr(alert_pass, "create_alerts", lambda _db, candidates: _value(len(candidates)))

    assert await alert_pass.run_alert_pass(object()) == 0


async def _value(value: Any) -> Any:
    return value


async def _raise_if_called() -> Any:
    raise AssertionError("position risk read must stay off")


def alert_pass_text(alert: Alert) -> str:
    # Position-risk alerts must land in their Book home, not a token ticket.
    from app.delivery.service import _message_text

    return _message_text(alert)


class _Scalars:
    def __init__(self, values: set[str]) -> None:
        self.values = values

    def __iter__(self):
        return iter(self.values)


class _AlertResult:
    def __init__(self, values: set[str]) -> None:
        self.values = values

    def scalars(self) -> _Scalars:
        return _Scalars(self.values)


class _AlertDb:
    def __init__(self) -> None:
        self.keys: set[str] = set()

    async def execute(self, _statement: Any) -> _AlertResult:
        return _AlertResult(self.keys)

    def add_all(self, rows: list[Alert]) -> None:
        self.keys.update(row.dedupe_key for row in rows)

    async def commit(self) -> None:
        return None


class _DeliveryScalars:
    def __init__(self, alert: Alert) -> None:
        self.alert = alert

    def __iter__(self):
        return iter([self.alert])


class _DeliveryResult:
    def __init__(self, alert: Alert) -> None:
        self.alert = alert

    def scalars(self) -> _DeliveryScalars:
        return _DeliveryScalars(self.alert)


class _DeliveryDb:
    def __init__(self, alert: Alert) -> None:
        self.alert = alert

    async def execute(self, _statement: Any) -> _DeliveryResult:
        return _DeliveryResult(self.alert)

    async def commit(self) -> None:
        return None
