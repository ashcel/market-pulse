"""Bug: the token page strips the USDT suffix for display (BTC not BTCUSDT),
so a bare ticker can reach /quant/token and the upstream forecast (which
needs the full Binance futures symbol) silently returns zero candles. The
`/token` handler must normalize the symbol before forwarding.
"""

from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.database import get_db
from app.main import app
from app.quant import router as quant_router

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)
    monkeypatch.setattr(settings, "PORT_FORECAST", False)

    async def override_get_db() -> AsyncIterator[Any]:
        yield None

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


def _stub_upstream(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def _fake_fetch(path: str, params: Any, init_data: Any) -> tuple[int, Any]:  # noqa: ARG001
        calls.append({"path": path, "params": params})
        return 200, {"symbol": params.get("symbol"), "candles": [], "forecast": []}

    monkeypatch.setattr(quant_router, "_fetch", _fake_fetch)
    return calls


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("BTC", "BTCUSDT"),
        ("btc", "BTCUSDT"),
        ("ETHUSDT", "ETHUSDT"),
        ("1000pepe", "1000PEPEUSDT"),
    ],
)
async def test_token_symbol_normalized_before_forwarding(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, raw: str, expected: str
) -> None:
    calls = _stub_upstream(monkeypatch)

    resp = await client.get(
        "/api/v1/quant/token", params={"symbol": raw}, headers=headers_for(USER_A)
    )

    assert resp.status_code == 200
    assert calls == [{"path": "/api/token", "params": {"symbol": expected}}]


def test_normalize_symbol_unit() -> None:
    assert quant_router._normalize_symbol("BTC") == "BTCUSDT"
    assert quant_router._normalize_symbol("btc") == "BTCUSDT"
    assert quant_router._normalize_symbol("ETHUSDT") == "ETHUSDT"
    assert quant_router._normalize_symbol("1000pepe") == "1000PEPEUSDT"
    assert quant_router._normalize_symbol("btc-usdt") == "BTCUSDT"


def test_normalize_symbol_empty_after_strip_raises() -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        quant_router._normalize_symbol("---")
    assert exc_info.value.status_code == 400
