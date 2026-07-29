from httpx import AsyncClient


async def test_health(client: AsyncClient, monkeypatch) -> None:
    async def healthy(_db):
        return {
            "status": "ok",
            "checks": {
                "database": "ok",
                "worker": {"status": "ok", "last_heartbeat": "2026-07-27T00:00:00Z"},
                "websocket": "idle",
                "sync": {"trades": "ok", "forensics": "ok", "catalysts": "ok"},
                "resources": {"memory_pct": 45, "disk_pct": 32},
            },
        }

    monkeypatch.setattr("app.main.build_health", healthy)
    resp = await client.get("/api/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"]["status"] == "ok"
    assert body["data"]["checks"]["database"] == "ok"
    assert body["error"] is None
