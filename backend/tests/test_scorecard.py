"""Sprint 5 evidence plane (docs/IMPLEMENTATION-PLAN.md §3 Sprint 5 tasks 1-2).

Two layers, deliberately split:

* The Evidence fold (`n < 20 -> insufficient`) is pure and runs everywhere.
* `compute_scorecard` reads `shadow_signal` — the forward-test settlement table
  the Python worker writes. That table is Postgres-only (`gen_random_uuid()`,
  `'active'::text` defaults, a partial unique index), so these tests run
  against a real scratch Postgres and SKIP without one. Faking the settlement
  table in sqlite would test a table shape production does not have, and the
  whole point of §1.5-#5 is that the scorecard reuses the *real* settlement
  code path.

Provision the scratch DB exactly as the sprint verification did:

    docker exec market-pulse-db psql -U postgres -c 'CREATE DATABASE market_pulse_s5dev'
    docker exec market-pulse-db bash -c \\
      'pg_dump -U postgres --schema-only market_pulse | psql -U postgres -d market_pulse_s5dev'
    DATABASE_URL=<scratch> alembic stamp a7c3d9e1f204 && alembic upgrade head
    export SCORECARD_TEST_DATABASE_URL=<scratch>

`SCORECARD_TEST_DATABASE_URL` must differ from `DATABASE_URL`; the fixture
refuses to run otherwise, because this box is production (CLAUDE.md).
"""

import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.forward_test.models import ShadowSignalRow
from app.opportunities.service import EVIDENCE_MIN_N, Evidence, evidence_for
from app.scorecard.models import SourceScorecard
from app.scorecard.service import (
    compute_scorecard,
    evidence_table_for,
    list_scorecard,
    run_scorecard_pass,
)
from app.signals.repo import insert_signal, list_signals, status_for_source

NOW = datetime(2026, 8, 1, 12, 0, tzinfo=UTC)

_SCRATCH_URL = os.environ.get("SCORECARD_TEST_DATABASE_URL", "")
_needs_pg = pytest.mark.skipif(
    not _SCRATCH_URL,
    reason="set SCORECARD_TEST_DATABASE_URL to an isolated Postgres (see module docstring)",
)


# --- pure: the honesty rule ------------------------------------------------


def test_evidence_absent_table_is_insufficient() -> None:
    """Flag off / cron never ran is the same answer as "not enough": no number."""
    ev = evidence_for({"quant"}, "intraday", None)
    assert ev == Evidence(status="insufficient", n=0, hit_rate=None, avg_r=None, window_days=30)


def test_evidence_below_min_n_reports_n_but_no_percentage() -> None:
    table = {("quant", "intraday"): (EVIDENCE_MIN_N - 1, 0.61, 0.42, 30)}
    ev = evidence_for({"quant"}, "intraday", table)
    assert ev.status == "insufficient"
    assert ev.n == EVIDENCE_MIN_N - 1
    # R3: a hit-rate off 19 samples reads as earned and is not.
    assert ev.hit_rate is None
    assert ev.avg_r is None


def test_evidence_at_min_n_reports_numbers() -> None:
    table = {("quant", "intraday"): (EVIDENCE_MIN_N, 0.61, 0.42, 30)}
    ev = evidence_for({"quant"}, "intraday", table)
    assert ev.status == "ok"
    assert ev.n == EVIDENCE_MIN_N
    assert ev.hit_rate == pytest.approx(0.61)
    assert ev.avg_r == pytest.approx(0.42)


def test_evidence_across_sources_is_n_weighted() -> None:
    """Two sources on one card: the one with more settled signals weighs more."""
    table = {
        ("quant", "swing"): (30, 0.60, 0.30, 30),
        ("smc", "swing"): (10, 0.20, -0.10, 30),
    }
    ev = evidence_for({"quant", "smc"}, "swing", table)
    assert ev.n == 40
    assert ev.hit_rate == pytest.approx((0.60 * 30 + 0.20 * 10) / 40)
    assert ev.avg_r == pytest.approx((0.30 * 30 + -0.10 * 10) / 40)


def test_evidence_ignores_other_horizons() -> None:
    table = {("quant", "scalp"): (500, 0.9, 2.0, 30)}
    assert evidence_for({"quant"}, "swing", table).status == "insufficient"


def test_status_for_source_follows_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    """A writer never promotes itself — the operator's allowlist decides."""
    monkeypatch.setattr(settings, "SIGNAL_SOURCES_LIVE", ["quant"])
    assert status_for_source("quant") == "live"
    assert status_for_source("smc") == "shadow"


@_needs_pg
async def test_scorecard_pass_disabled_writes_nothing(pg_session: Any) -> None:
    """SCORECARD_ENABLED=0 must be a no-op, not an empty recompute: the cron is
    registered unconditionally and ticks every midnight before the flag flips."""
    pg_session.add(_scorecard_row(source="stale", n=99))
    await pg_session.commit()

    settings.SCORECARD_ENABLED = False
    try:
        result = await run_scorecard_pass(pg_session)
    finally:
        settings.SCORECARD_ENABLED = False

    assert result == "[scorecard] disabled (SCORECARD_ENABLED=0)"
    # The pre-existing row survived — nothing was deleted, nothing recomputed.
    assert [row.source for row in await list_scorecard(pg_session)] == ["stale"]


# --- postgres fixtures -----------------------------------------------------


@pytest.fixture
async def pg_session() -> AsyncIterator[Any]:
    if not _SCRATCH_URL:
        pytest.skip("SCORECARD_TEST_DATABASE_URL unset")
    if str(settings.DATABASE_URL) == _SCRATCH_URL:
        pytest.fail("SCORECARD_TEST_DATABASE_URL must not be the production DATABASE_URL")

    engine = create_async_engine(_SCRATCH_URL, poolclass=None)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        # TRUNCATE, not DELETE: signal_events carries the append-only row
        # trigger and DELETE is supposed to raise. TRUNCATE fires no row
        # triggers, which is why the table can still be reset for a test.
        await session.execute(text("TRUNCATE signal_events, source_scorecard, shadow_signal"))
        await session.commit()
        yield session
    await engine.dispose()


def _scorecard_row(**over: Any) -> SourceScorecard:
    base: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "source": "quant",
        "source_version": "abc1234",
        "regime": "bull",
        "horizon": "intraday",
        "window_days": 30,
        "n": 0,
        "hit_rate": None,
        "avg_r": None,
        "computed_at": NOW,
    }
    base.update(over)
    return SourceScorecard(**base)


def _shadow(
    *,
    symbol: str,
    direction: str,
    intent: str,
    result_r: float,
    opened_at: datetime,
    regime: str = "bull",
    status: str = "hit_tp",
) -> ShadowSignalRow:
    return ShadowSignalRow(
        id=str(uuid.uuid4()),
        symbol=symbol,
        market="perp",
        intent=intent,
        direction=direction,
        setup_type="continuation",
        regime=regime,
        # NOT the horizon: `timeframe` is the execution TF, `intent` is what the
        # scorecard joins on.
        timeframe="1H",
        entry=100.0,
        stop=95.0,
        target1=110.0,
        target2=120.0,
        confidence=0.7,
        opened_at=opened_at,
        status=status,
        closed_at=opened_at + timedelta(hours=6),
        close_price=110.0,
        result_r=result_r,
        engine_version="2.0.0",
        config_hash="cfg",
        git_sha="sha",
    )


async def _add_signal(
    db: Any,
    *,
    symbol: str,
    side: str = "long",
    horizon: str = "intraday",
    source: str = "quant",
    detected_at: datetime,
    kind: str = "ma-alignment",
    status: str = "live",
    context_ref: dict[str, Any] | None = None,
) -> None:
    await insert_signal(
        db,
        id=str(uuid.uuid4()),
        source=source,
        source_version="abc1234",
        symbol=symbol,
        side=side,
        horizon=horizon,
        kind=kind,
        conviction="high",
        detected_at=detected_at,
        expires_at=None,
        features={},
        dedup_key=f"{source}|{symbol}|{side}|{horizon}|{detected_at.isoformat()}|{kind}",
        status=status,
        context_ref=context_ref,
    )


# --- signal_events: the two Sprint 5 columns -------------------------------


@_needs_pg
async def test_signal_events_status_defaults_and_filters(pg_session: Any) -> None:
    await _add_signal(pg_session, symbol="BTCUSDT", detected_at=NOW, status="live")
    await _add_signal(pg_session, symbol="ETHUSDT", detected_at=NOW, source="smc", status="shadow")

    since = NOW - timedelta(days=1)
    assert {e.symbol for e in await list_signals(pg_session, since=since)} == {
        "BTCUSDT",
        "ETHUSDT",
    }
    # The read models ask for live only: a shadow source is recorded, not shown.
    live = await list_signals(pg_session, since=since, status="live")
    assert [e.symbol for e in live] == ["BTCUSDT"]
    assert [e.symbol for e in await list_signals(pg_session, since=since, status="shadow")] == [
        "ETHUSDT"
    ]


@_needs_pg
async def test_signal_events_context_ref_roundtrips(pg_session: Any) -> None:
    await _add_signal(
        pg_session,
        symbol="SOLUSDT",
        detected_at=NOW,
        context_ref={"regime": "bull", "breadth": 0.62},
    )
    rows = await list_signals(pg_session, since=NOW - timedelta(days=1))
    assert rows[0].context_ref == {"regime": "bull", "breadth": 0.62}


@_needs_pg
async def test_new_columns_do_not_weaken_append_only(pg_session: Any) -> None:
    """The whole contract: adding columns must not open a mutation path."""
    await _add_signal(pg_session, symbol="BTCUSDT", detected_at=NOW)

    with pytest.raises(DBAPIError, match="append-only"):
        await pg_session.execute(text("UPDATE signal_events SET status = 'shadow'"))
    await pg_session.rollback()

    with pytest.raises(DBAPIError, match="append-only"):
        await pg_session.execute(text("DELETE FROM signal_events"))
    await pg_session.rollback()


# --- compute_scorecard: settlement reuse -----------------------------------


@_needs_pg
async def test_compute_scorecard_reuses_forward_test_settlement(pg_session: Any) -> None:
    """Hit/miss comes from `shadow_signal.result_r` — the number the forward-test
    worker already settled — not from a second settlement implementation."""
    detected = NOW - timedelta(days=2)
    for i in range(4):
        await _add_signal(pg_session, symbol=f"SYM{i}USDT", detected_at=detected)
    # 3 winners, 1 loser, all matched within the ±2h window.
    for i, r in enumerate([1.5, 2.0, 0.5, -1.0]):
        pg_session.add(
            _shadow(
                symbol=f"SYM{i}USDT",
                direction="long",
                intent="intraday",
                result_r=r,
                opened_at=detected + timedelta(minutes=10),
            )
        )
    await pg_session.commit()

    rows = await compute_scorecard(pg_session, window_days=30, now=NOW)
    bull = [r for r in rows if r.regime == "bull"]
    assert len(bull) == 1
    assert bull[0].n == 4
    assert bull[0].hit_rate == pytest.approx(0.75)
    assert bull[0].avg_r == pytest.approx((1.5 + 2.0 + 0.5 - 1.0) / 4)
    assert bull[0].source == "quant"
    assert bull[0].horizon == "intraday"


@_needs_pg
async def test_compute_scorecard_matches_on_intent_not_timeframe(pg_session: Any) -> None:
    """A scalp signal must not bank a swing settlement on the same symbol."""
    detected = NOW - timedelta(days=1)
    await _add_signal(pg_session, symbol="BTCUSDT", horizon="scalp", detected_at=detected)
    pg_session.add(
        _shadow(
            symbol="BTCUSDT",
            direction="long",
            intent="swing",
            result_r=3.0,
            opened_at=detected,
        )
    )
    await pg_session.commit()

    rows = await compute_scorecard(pg_session, window_days=30, now=NOW)
    assert [(r.horizon, r.n) for r in rows] == [("scalp", 0)]


@_needs_pg
async def test_compute_scorecard_credits_a_settlement_once(pg_session: Any) -> None:
    """Two detectors from one source firing on the same setup are one opinion;
    counting the settlement twice would inflate n and the hit-rate with it."""
    detected = NOW - timedelta(days=1)
    await _add_signal(pg_session, symbol="BTCUSDT", detected_at=detected, kind="ma-alignment")
    await _add_signal(pg_session, symbol="BTCUSDT", detected_at=detected, kind="bos-bullish")
    pg_session.add(
        _shadow(
            symbol="BTCUSDT",
            direction="long",
            intent="intraday",
            result_r=2.0,
            opened_at=detected,
        )
    )
    await pg_session.commit()

    rows = await compute_scorecard(pg_session, window_days=30, now=NOW)
    assert sum(r.n for r in rows) == 1


@_needs_pg
async def test_compute_scorecard_ignores_settlements_outside_the_window(
    pg_session: Any,
) -> None:
    detected = NOW - timedelta(days=1)
    await _add_signal(pg_session, symbol="BTCUSDT", detected_at=detected)
    pg_session.add(
        _shadow(
            symbol="BTCUSDT",
            direction="long",
            intent="intraday",
            result_r=2.0,
            # Opened a day away from detection: a different setup entirely.
            opened_at=detected + timedelta(hours=20),
        )
    )
    await pg_session.commit()

    rows = await compute_scorecard(pg_session, window_days=30, now=NOW)
    assert sum(r.n for r in rows) == 0


@_needs_pg
async def test_compute_scorecard_slices_by_regime(pg_session: Any) -> None:
    detected = NOW - timedelta(days=1)
    for i in range(2):
        await _add_signal(pg_session, symbol=f"B{i}USDT", detected_at=detected)
    pg_session.add(
        _shadow(
            symbol="B0USDT",
            direction="long",
            intent="intraday",
            result_r=1.0,
            regime="bull",
            opened_at=detected,
        )
    )
    pg_session.add(
        _shadow(
            symbol="B1USDT",
            direction="long",
            intent="intraday",
            result_r=-1.0,
            regime="chop",
            opened_at=detected,
        )
    )
    await pg_session.commit()

    rows = {r.regime: r for r in await compute_scorecard(pg_session, window_days=30, now=NOW)}
    assert rows["bull"].hit_rate == pytest.approx(1.0)
    assert rows["chop"].hit_rate == pytest.approx(0.0)


@_needs_pg
async def test_unsettled_signals_stay_insufficient_end_to_end(pg_session: Any) -> None:
    """A source with signals but no settlements scores n=0, and the Evidence
    fold turns that into "Belum cukup data" rather than 0%."""
    detected = NOW - timedelta(days=1)
    await _add_signal(pg_session, symbol="BTCUSDT", detected_at=detected)
    await pg_session.commit()

    for row in await compute_scorecard(pg_session, window_days=30, now=NOW):
        pg_session.add(row)
    await pg_session.commit()

    table = await evidence_table_for(pg_session)
    assert evidence_for({"quant"}, "intraday", table).status == "insufficient"


@_needs_pg
async def test_scorecard_pass_enabled_replaces_rows(pg_session: Any) -> None:
    detected = NOW - timedelta(days=1)
    for i in range(2):
        await _add_signal(pg_session, symbol=f"C{i}USDT", detected_at=detected)
        pg_session.add(
            _shadow(
                symbol=f"C{i}USDT",
                direction="long",
                intent="intraday",
                result_r=1.0,
                opened_at=detected,
            )
        )
    pg_session.add(_scorecard_row(source="stale", n=99))
    await pg_session.commit()

    settings.SCORECARD_ENABLED = True
    try:
        result = await run_scorecard_pass(pg_session)
    finally:
        settings.SCORECARD_ENABLED = False

    assert result.startswith("[scorecard] computed=")
    stored = await list_scorecard(pg_session)
    # Atomic replace: the stale row is gone, not merged with.
    assert "stale" not in {row.source for row in stored}
    assert sum(row.n for row in stored) == 2


@_needs_pg
async def test_scorecard_ignores_open_shadow_records(pg_session: Any) -> None:
    """`result_r IS NULL` = still running. Scoring it as a miss would make every
    fresh idea look like a loss."""
    detected = NOW - timedelta(days=1)
    await _add_signal(pg_session, symbol="BTCUSDT", detected_at=detected)
    open_row = _shadow(
        symbol="BTCUSDT",
        direction="long",
        intent="intraday",
        result_r=1.0,
        opened_at=detected,
        status="active",
    )
    open_row.result_r = None
    open_row.closed_at = None
    pg_session.add(open_row)
    await pg_session.commit()

    assert sum(r.n for r in await compute_scorecard(pg_session, window_days=30, now=NOW)) == 0
