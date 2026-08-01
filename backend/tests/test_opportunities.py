"""Sprint 2 opportunity read-model tests (docs/IMPLEMENTATION-PLAN.md §2.3):
grouping, the ranking formula, the regime gate, honest evidence, and the
endpoint answering purely from `signal_events` (no upstream call).
"""

import math
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import get_db
from app.forward_test.models import EvalLog
from app.main import app
from app.opportunities.service import (
    build_opportunities,
    freshness,
    normalize_conviction,
    rank_score,
    regime_alignment_for,
)
from app.signals.models import SignalEvent

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"
NOW = datetime(2026, 8, 1, 12, 0, tzinfo=UTC)


# `eval_log` (the regime source) is a Postgres-native table with JSONB columns.
# Rendering them as JSON lets the endpoint test exercise the real regime join
# on sqlite; production still gets JSONB, since this only registers a compiler
# for the sqlite dialect.
@compiles(JSONB, "sqlite")
def _compile_jsonb_on_sqlite(type_: Any, compiler: Any, **kw: Any) -> str:  # noqa: ARG001
    return "JSON"


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


def make_event(**overrides: Any) -> SignalEvent:
    defaults: dict[str, Any] = {
        "id": overrides.get("dedup_key", "id-1"),
        "source": "quant",
        "source_version": "abc1234",
        "symbol": "BTCUSDT",
        "side": "long",
        "horizon": "swing",
        "kind": "ma-alignment",
        "conviction": "high",
        "detected_at": NOW - timedelta(hours=1),
        "expires_at": None,
        "features": {},
        "dedup_key": "quant|BTCUSDT|long|swing|2026-08-01|ma-alignment",
    }
    defaults.update(overrides)
    return SignalEvent(**defaults)


# --- ranking formula -----------------------------------------------------


def test_rank_formula_matches_the_written_spec() -> None:
    # high (1.0) * 2 sources (1.35) * freshness(6h) * counter (0.4)
    score = rank_score(
        conviction="high",
        source_count=2,
        last_detected_at=NOW - timedelta(hours=6),
        regime_alignment="counter",
        now=NOW,
    )
    expected = 1.0 * (1 + 0.35 * 1) * math.exp(-6 / 12) * 0.4
    assert score == pytest.approx(expected)


def test_freshness_decays_with_a_12h_scale() -> None:
    assert freshness(NOW, NOW) == pytest.approx(1.0)
    assert freshness(NOW - timedelta(hours=12), NOW) == pytest.approx(math.exp(-1))
    # Clock skew must not manufacture a score above 1.
    assert freshness(NOW + timedelta(hours=3), NOW) == pytest.approx(1.0)


def test_very_high_outranks_high_but_counter_regime_sinks_it() -> None:
    strong_counter = rank_score(
        conviction="very_high",
        source_count=1,
        last_detected_at=NOW,
        regime_alignment="counter",
        now=NOW,
    )
    weak_aligned = rank_score(
        conviction="medium",
        source_count=1,
        last_detected_at=NOW,
        regime_alignment="aligned",
        now=NOW,
    )
    assert strong_counter < weak_aligned


def test_conviction_aliases_normalise() -> None:
    assert normalize_conviction("very-high") == "very_high"
    assert normalize_conviction("HIGH") == "high"
    assert normalize_conviction("garbage") is None
    assert normalize_conviction(None) is None


def test_regime_alignment_gate() -> None:
    assert regime_alignment_for("bull", "long") == "aligned"
    assert regime_alignment_for("bull", "short") == "counter"
    assert regime_alignment_for("bear", "short") == "aligned"
    assert regime_alignment_for("uptrend", "long") == "aligned"
    assert regime_alignment_for("choppy", "long") == "neutral"
    assert regime_alignment_for(None, "long") == "neutral"


# --- grouping ------------------------------------------------------------


def test_two_detectors_same_symbol_day_make_one_card() -> None:
    events = [
        make_event(dedup_key="k1", kind="ma-alignment", conviction="medium"),
        make_event(
            dedup_key="k2",
            kind="bos-bullish",
            conviction="high",
            detected_at=NOW - timedelta(minutes=30),
        ),
    ]
    cards = build_opportunities(events, regimes={}, now=NOW)

    assert len(cards) == 1
    card = cards[0]
    assert card.key == "BTCUSDT|long|swing|2026-08-01"
    assert len(card.sources) == 2
    assert card.conviction == "high"  # strongest of the two
    assert card.first_detected_at < card.last_detected_at


def test_same_source_twice_earns_no_agreement_bonus() -> None:
    """Two detectors inside one app are one opinion — the multi-source bonus
    must not pay out for it."""
    two_detectors_one_source = build_opportunities(
        [
            make_event(dedup_key="k1", kind="ma-alignment"),
            make_event(dedup_key="k2", kind="bos-bullish"),
        ],
        regimes={},
        now=NOW,
    )[0]
    two_sources = build_opportunities(
        [
            make_event(dedup_key="k1", kind="ma-alignment"),
            make_event(dedup_key="k2", kind="bos-bullish", source="smc"),
        ],
        regimes={},
        now=NOW,
    )[0]
    assert two_sources.rank_score > two_detectors_one_source.rank_score


def test_opposite_sides_and_other_days_stay_separate_cards() -> None:
    events = [
        make_event(dedup_key="k1"),
        make_event(dedup_key="k2", side="short"),
        make_event(dedup_key="k3", detected_at=NOW - timedelta(days=1)),
    ]
    cards = build_opportunities(events, regimes={}, now=NOW)
    assert len(cards) == 3


def test_counter_regime_is_ranked_down_not_dropped() -> None:
    events = [
        make_event(dedup_key="k1", symbol="BTCUSDT", side="long"),
        make_event(dedup_key="k2", symbol="ETHUSDT", side="short", conviction="high"),
    ]
    cards = build_opportunities(events, regimes={"BTCUSDT": "bull", "ETHUSDT": "bull"}, now=NOW)

    assert [card.symbol for card in cards] == ["BTCUSDT", "ETHUSDT"]
    assert cards[0].regime_alignment == "aligned"
    assert cards[1].regime_alignment == "counter"  # still present, just last


def test_evidence_is_insufficient_with_no_numbers() -> None:
    card = build_opportunities([make_event()], regimes={}, now=NOW)[0]
    assert card.evidence.status == "insufficient"
    assert card.evidence.n == 0
    assert card.evidence.hit_rate is None
    assert card.evidence.avg_r is None


def test_reason_is_display_ready_indonesian() -> None:
    card = build_opportunities([make_event()], regimes={}, now=NOW)[0]
    assert card.sources[0].reason == "quant melihat ma-alignment arah naik, keyakinan tinggi"


def test_limit_keeps_the_highest_ranked() -> None:
    events = [
        make_event(dedup_key=f"k{i}", symbol=f"SYM{i}USDT", conviction=conviction)
        for i, conviction in enumerate(["low", "medium", "high"])
    ]
    cards = build_opportunities(events, regimes={}, now=NOW, limit=2)
    assert [card.symbol for card in cards] == ["SYM2USDT", "SYM1USDT"]


# --- endpoint ------------------------------------------------------------


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)

    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            SignalEvent.metadata.create_all, tables=[SignalEvent.__table__, EvalLog.__table__]
        )
    factory = async_sessionmaker(engine, expire_on_commit=False)

    now = datetime.now(UTC)
    async with factory() as session:
        session.add_all(
            [
                make_event(
                    dedup_key="s1",
                    id="s1",
                    symbol="BTCUSDT",
                    kind="ma-alignment",
                    detected_at=now - timedelta(hours=2),
                    features={"notified": True, "rank": 8},
                ),
                make_event(
                    dedup_key="s2",
                    id="s2",
                    symbol="BTCUSDT",
                    kind="bos-bullish",
                    detected_at=now - timedelta(hours=1),
                ),
                make_event(
                    dedup_key="s3",
                    id="s3",
                    symbol="ETHUSDT",
                    side="short",
                    conviction="medium",
                    horizon="intraday",
                    detected_at=now - timedelta(hours=3),
                ),
            ]
        )
        session.add(
            EvalLog(
                id="e1",
                evaluated_at=now,
                symbol="ETHUSDT",
                market="spot",
                intent="swing",
                verdict="favored",
                setup_type="continuation",
                regime="bull",
                timeframe="4H",
                engine_version="2.0.0",
                config_hash="h",
                git_sha="g",
            )
        )
        await session.commit()

    async def override_get_db() -> AsyncIterator[Any]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


async def test_opportunities_requires_auth(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/opportunities")).status_code == 401


async def test_opportunities_returns_cards_from_seeded_rows(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/opportunities", headers=headers_for(USER_A))
    assert resp.status_code == 200
    cards = resp.json()["data"]

    assert len(cards) == 2  # BTC long (2 detectors, one card) + ETH short
    btc = next(card for card in cards if card["symbol"] == "BTCUSDT")
    assert len(btc["sources"]) == 2
    assert btc["evidence"]["status"] == "insufficient"
    assert btc["evidence"]["hit_rate"] is None
    # No eval_log row for BTC: an absent regime is neutral, never faked agreement.
    assert btc["regime_alignment"] == "neutral"

    # ETH short against a seeded 'bull' regime: kept, marked, ranked last.
    eth = next(card for card in cards if card["symbol"] == "ETHUSDT")
    assert eth["regime_alignment"] == "counter"
    assert cards[-1]["symbol"] == "ETHUSDT"


async def test_opportunities_filters_by_horizon(client: AsyncClient) -> None:
    resp = await client.get(
        "/api/v1/opportunities", params={"horizon": "intraday"}, headers=headers_for(USER_A)
    )
    assert resp.status_code == 200
    cards = resp.json()["data"]
    assert [card["symbol"] for card in cards] == ["ETHUSDT"]


async def test_opportunities_respects_source_allowlist(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "SIGNAL_SOURCES_LIVE", ["smc"])
    resp = await client.get("/api/v1/opportunities", headers=headers_for(USER_A))
    assert resp.status_code == 200
    assert resp.json()["data"] == []
