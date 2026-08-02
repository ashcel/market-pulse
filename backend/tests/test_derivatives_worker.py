"""The 5-minute derivatives collection tick.

What matters here is not that it fetches — it is that it is idempotent under
retry (ON CONFLICT DO NOTHING on the floored slot), that one dead symbol
cannot end the tick, and that it is a no-op while `DERIVATIVES_ENABLED` is
off. Binance itself is never contacted: every fetcher is substituted.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from smc.market import UniverseEntry
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.derivatives import repo
from app.derivatives.binance import RawDerivatives, floor_to_slot
from app.derivatives.constants import SNAPSHOT_INTERVAL_S
from app.derivatives.models import DerivativesSnapshot
from app.worker import derivatives_pass as pass_module
from app.worker.derivatives_pass import run_derivatives_pass

NOW = datetime(2026, 8, 2, 12, 3, 41, tzinfo=UTC)
SLOT = floor_to_slot(NOW, SNAPSHOT_INTERVAL_S)


@pytest.fixture
async def session_factory() -> AsyncIterator[Any]:
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            DerivativesSnapshot.metadata.create_all, tables=[DerivativesSnapshot.__table__]
        )
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


def sample(symbol: str, timestamp: datetime) -> RawDerivatives:
    return RawDerivatives(
        symbol=symbol,
        timestamp=timestamp,
        open_interest=1000.0,
        open_interest_usd=100_000.0,
        funding_rate=0.0001,
        long_short_ratio=1.2,
        top_trader_accounts_ratio=1.1,
        top_trader_positions_ratio=1.15,
        taker_buy_volume=74.0,
        taker_sell_volume=26.0,
        basis=0.5,
        premium=0.0004,
        oi_marketcap_ratio=0.02,
        price=100.0,
    )


@pytest.fixture
def stub_universe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        pass_module,
        "WORKER_UNIVERSE",
        [UniverseEntry("BTC", "Bitcoin", "Majors"), UniverseEntry("ETH", "Ethereum", "Majors")],
    )


@pytest.fixture
def stub_fetchers(monkeypatch: pytest.MonkeyPatch, stub_universe: None) -> None:  # noqa: ARG001
    async def fake_snapshot(
        ticker: str,
        *,
        timestamp: datetime,
        market_cap: float | None = None,  # noqa: ARG001
    ) -> RawDerivatives:
        return sample(f"{ticker}USDT", timestamp)

    async def fake_caps(tickers: list[str], **_: Any) -> dict[str, float]:
        return {ticker: 1_000_000_000.0 for ticker in tickers}

    async def no_backfill(pair: str, **_: Any) -> list[dict[str, float]]:  # noqa: ARG001
        return []

    monkeypatch.setattr(pass_module, "fetch_snapshot", fake_snapshot)
    monkeypatch.setattr(pass_module, "fetch_market_caps", fake_caps)
    monkeypatch.setattr(pass_module, "fetch_open_interest_hist", no_backfill)
    monkeypatch.setattr(settings, "DERIVATIVES_ENABLED", True)


# --- the gate ------------------------------------------------------------


async def test_tick_is_a_no_op_while_disabled(
    session_factory: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "DERIVATIVES_ENABLED", False)
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        assert summary == "[derivatives] disabled (DERIVATIVES_ENABLED=0)"
        assert list(await repo.list_symbols(session)) == []


# --- collection ----------------------------------------------------------


async def test_tick_writes_one_row_per_symbol(session_factory: Any, stub_fetchers: None) -> None:  # noqa: ARG001
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        assert "written=2" in summary
        assert sorted(await repo.list_symbols(session)) == ["BTCUSDT", "ETHUSDT"]

        series = await repo.load_series(session, "BTCUSDT", lookback_s=3600, now=NOW)
        assert len(series) == 1
        assert series[0].timestamp == SLOT
        assert series[0].funding_rate == pytest.approx(0.0001)


async def test_tick_floors_the_timestamp_onto_the_five_minute_grid(
    session_factory: Any,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    assert SLOT == datetime(2026, 8, 2, 12, 0, tzinfo=UTC)  # noqa: SIM300
    async with session_factory() as session:
        await run_derivatives_pass(session, now=NOW)
        series = await repo.load_series(session, "BTCUSDT", lookback_s=3600, now=NOW)
        assert series[0].timestamp == SLOT


async def test_retrying_the_same_slot_writes_nothing(
    session_factory: Any,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    """The idempotency contract: a retry inside the slot re-derives the same
    (symbol, timestamp) and is dropped by ON CONFLICT DO NOTHING."""
    async with session_factory() as session:
        first = await run_derivatives_pass(session, now=NOW)
        # A different wall clock inside the same 5-minute slot.
        second = await run_derivatives_pass(session, now=NOW + timedelta(seconds=60))
        assert "written=2" in first
        assert "written=0" in second
        assert "collected=2" in second

        series = await repo.load_series(session, "BTCUSDT", lookback_s=3600, now=NOW)
        assert len(series) == 1


async def test_the_next_slot_appends_a_new_row(
    session_factory: Any,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    async with session_factory() as session:
        await run_derivatives_pass(session, now=NOW)
        await run_derivatives_pass(session, now=NOW + timedelta(minutes=5))
        series = await repo.load_series(session, "BTCUSDT", lookback_s=3600, now=NOW)
        assert len(series) == 2


# --- failure isolation ---------------------------------------------------


async def test_one_dead_symbol_does_not_end_the_tick(
    session_factory: Any,
    monkeypatch: pytest.MonkeyPatch,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    async def flaky(
        ticker: str,
        *,
        timestamp: datetime,
        market_cap: float | None = None,  # noqa: ARG001
    ) -> RawDerivatives:
        if ticker == "BTC":
            raise RuntimeError("upstream exploded")
        return sample(f"{ticker}USDT", timestamp)

    monkeypatch.setattr(pass_module, "fetch_snapshot", flaky)
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        assert "written=1" in summary
        assert "failed=1" in summary
        assert list(await repo.list_symbols(session)) == ["ETHUSDT"]


async def test_a_timed_out_symbol_is_skipped(
    session_factory: Any,
    monkeypatch: pytest.MonkeyPatch,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    async def slow(
        ticker: str,
        *,
        timestamp: datetime,
        market_cap: float | None = None,  # noqa: ARG001
    ) -> RawDerivatives:
        if ticker == "BTC":
            raise TimeoutError
        return sample(f"{ticker}USDT", timestamp)

    monkeypatch.setattr(pass_module, "fetch_snapshot", slow)
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        assert "written=1" in summary
        assert "failed=1" in summary


async def test_an_empty_snapshot_is_not_written(
    session_factory: Any,
    monkeypatch: pytest.MonkeyPatch,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    """A row carrying nothing but NULLs would only inflate `sample_count`."""

    async def blank(
        ticker: str,
        *,
        timestamp: datetime,
        market_cap: float | None = None,  # noqa: ARG001
    ) -> RawDerivatives:
        empty = sample(f"{ticker}USDT", timestamp)
        return RawDerivatives(
            **{
                **{field: getattr(empty, field) for field in empty.__slots__},
                "open_interest": None,
                "price": None,
            }
        )

    monkeypatch.setattr(pass_module, "fetch_snapshot", blank)
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        assert "written=0" in summary
        assert "failed=2" in summary


async def test_a_market_cap_outage_still_collects(
    session_factory: Any,
    monkeypatch: pytest.MonkeyPatch,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    async def broken_caps(tickers: list[str], **_: Any) -> dict[str, float]:  # noqa: ARG001
        raise RuntimeError("coingecko down")

    monkeypatch.setattr(pass_module, "fetch_market_caps", broken_caps)
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        assert "written=2" in summary


# --- cold-start backfill -------------------------------------------------


async def test_cold_start_backfills_oi_history(
    session_factory: Any,
    monkeypatch: pytest.MonkeyPatch,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    async def history(pair: str, **_: Any) -> list[dict[str, float]]:  # noqa: ARG001
        base_ms = SLOT.timestamp() * 1000
        return [
            {
                "timestamp": base_ms - index * SNAPSHOT_INTERVAL_S * 1000,
                "open_interest": 900.0 + index,
                "open_interest_usd": (900.0 + index) * 100,
            }
            for index in range(4)
        ]

    monkeypatch.setattr(pass_module, "fetch_open_interest_hist", history)
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        # 3 historical buckets per symbol; the current slot is excluded so the
        # full live snapshot is never pre-empted by a partial row.
        assert "backfilled=6" in summary
        assert "written=2" in summary

        series = await repo.load_series(session, "BTCUSDT", lookback_s=3600, now=NOW)
        assert len(series) == 4
        assert series[-1].timestamp == SLOT
        assert series[-1].funding_rate is not None
        # The backfilled rows carry OI only — nothing else was invented.
        assert series[0].funding_rate is None
        assert series[0].open_interest == pytest.approx(903.0)


async def test_backfill_runs_once_not_every_tick(
    session_factory: Any,
    monkeypatch: pytest.MonkeyPatch,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    calls: list[str] = []

    async def history(pair: str, **_: Any) -> list[dict[str, float]]:
        calls.append(pair)
        base_ms = SLOT.timestamp() * 1000
        return [
            {"timestamp": base_ms - index * SNAPSHOT_INTERVAL_S * 1000, "open_interest": 900.0}
            for index in range(1, 4)
        ]

    monkeypatch.setattr(pass_module, "fetch_open_interest_hist", history)
    async with session_factory() as session:
        await run_derivatives_pass(session, now=NOW)
        assert len(calls) == 2
        await run_derivatives_pass(session, now=NOW + timedelta(minutes=5))
        # Rows now exist, so the cold-start branch does not re-fire.
        assert len(calls) == 2


async def test_a_failed_insert_is_reported_not_raised(
    session_factory: Any,
    monkeypatch: pytest.MonkeyPatch,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    """A dead database ends the tick with a summary, not a traceback that
    would take the whole arq worker process down with it."""

    async def broken_insert(*_args: Any, **_kwargs: Any) -> int:
        raise RuntimeError("connection reset")

    monkeypatch.setattr(repo, "insert_snapshots", broken_insert)
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        assert summary.startswith("[derivatives] error")
        assert "collected=2" in summary


async def test_backfill_of_an_empty_history_is_a_no_op(
    session_factory: Any,
    stub_fetchers: None,  # noqa: ARG001
) -> None:
    async with session_factory() as session:
        summary = await run_derivatives_pass(session, now=NOW)
        assert "backfilled=0" in summary


# --- slot helper ---------------------------------------------------------


def test_floor_to_slot_snaps_down() -> None:
    assert floor_to_slot(NOW, 300) == datetime(2026, 8, 2, 12, 0, tzinfo=UTC)
    assert floor_to_slot(datetime(2026, 8, 2, 12, 7, 59), 300) == datetime(
        2026, 8, 2, 12, 5, tzinfo=UTC
    )
    assert floor_to_slot(datetime(2026, 8, 2, 12, 5, tzinfo=UTC), 300) == datetime(
        2026, 8, 2, 12, 5, tzinfo=UTC
    )
