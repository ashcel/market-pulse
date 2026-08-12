"""Scanner integration: store -> metrics -> events -> durable sections.

Drives the whole radar off synthetic ticker frames with an explicit clock, so a
symbol's full life (an anomaly fires, corroborates, confirms structurally,
fades, drops) is asserted end to end rather than only at the pure-engine layer.

The underlying MOMENTUM/PULLBACK/CONTINUATION machine is still exercised here,
but as what it now is: an internal source of structural events, not the UI's
categorization.
"""

from __future__ import annotations

import math
from collections.abc import Callable

import pytest
from httpx import AsyncClient
from smc.market_context import ContextTimeframe
from smc.scan_profiles import SCALP
from smc.types import Candle

from app.momentum.context_cache import ContextCache
from app.momentum.ingestor import MomentumIngestor
from app.momentum.scanner import MomentumScanner
from app.momentum.state import MarketStateStore, TickerFrame

T0 = 1_700_000_000.0
BASE_VOLUME = 8_640_000.0
BASE_TRADES = 86_400.0
QUIET_VOLUME_PER_SECOND = 100.0
QUIET_TRADES_PER_SECOND = 1.0


class Tape:
    """A synthetic all-market feed for one symbol, advancing one second per
    frame so window arithmetic in the store is exact."""

    def __init__(self, store: MarketStateStore, symbol: str = "TST") -> None:
        self.store = store
        self.symbol = symbol
        self.now = T0
        self.price = 100.0
        self.volume = BASE_VOLUME
        self.trades = BASE_TRADES

    def run(
        self,
        seconds: int,
        *,
        price: Callable[[int], float] | float | None = None,
        volume_mult: float = 1.0,
        trade_mult: float = 1.0,
    ) -> None:
        for step in range(1, seconds + 1):
            self.now += 1
            if callable(price):
                self.price = price(step)
            elif price is not None:
                self.price = price
            self.volume += QUIET_VOLUME_PER_SECOND * volume_mult
            self.trades += QUIET_TRADES_PER_SECOND * trade_mult
            self.store.ingest_batch(
                [
                    TickerFrame(
                        symbol=self.symbol,
                        price=self.price,
                        quote_volume_24h=self.volume,
                        trades_24h=self.trades,
                        change_24h_pct=12.0,
                        event_ts=self.now,
                    )
                ],
                self.now,
            )

    def ramp(self, seconds: int, to: float, **kwargs: float) -> None:
        start = self.price
        self.run(seconds, price=lambda s: start + (to - start) * (s / seconds), **kwargs)


class _StubKlines:
    """A kline source for context tests — the slow lane's only input."""

    def __init__(self, drift: float, base: float = 100.0) -> None:
        self.drift = drift
        self.base = base

    async def __call__(
        self, _symbol: str, _timeframe: ContextTimeframe, _limit: int
    ) -> list[Candle]:
        out: list[Candle] = []
        for index in range(120):
            mid = self.base + self.drift * index + 1.2 * math.sin(2 * math.pi * index / 12)
            out.append(
                Candle(
                    time=int(T0) + index * 3_600,
                    open=mid,
                    high=mid + 0.6,
                    low=mid - 0.6,
                    close=mid,
                    volume=1_000.0,
                )
            )
        return out


def build() -> tuple[MomentumScanner, Tape]:
    store = MarketStateStore()
    # No context cache work in these tests: the slow lane is covered by
    # test_momentum_context.py and must never be reached from a scan tick.
    scanner = MomentumScanner(store, MomentumIngestor(store), context_cache=ContextCache())
    return scanner, Tape(store)


def warm(tape: Tape, minutes: int = 25) -> None:
    """Quiet tape long enough for an observed baseline to form."""
    tape.run(minutes * 60, price=100.0)


def impulse(tape: Tape) -> None:
    """Three minutes of +2% on ~4x volume and ~4x trades."""
    tape.ramp(180, to=102.0, volume_mult=4.0, trade_mult=4.0)






def symbols(entries: list[object]) -> list[str]:
    return [e.situation.symbol for e in entries]  # type: ignore[attr-defined]


def event_types(scanner: MomentumScanner, symbol: str = "TST", mode: str = "SCALP") -> set[str]:
    tracker = scanner.tracker(symbol, mode)
    return {e.type for e in tracker.events} if tracker is not None else set()


async def with_context(
    scanner: MomentumScanner, tape: Tape, drift: float = -0.02, base: float = 100.0
) -> None:
    """Give the slow lane a structure to work from, at the tape's own price
    level so its levels are actually reachable."""
    scanner.context_cache._fetch = _StubKlines(drift, base=base)  # type: ignore[attr-defined]
    scanner.context_cache.track(["TST"], tape.now)
    await scanner.context_cache.refresh_once(tape.now)


# ── observation → event ──────────────────────────────────────────────────────


def test_an_impulse_becomes_a_tracked_event() -> None:
    scanner, tape = build()
    warm(tape)
    scanner.tick(tape.now)
    assert scanner.tracker("TST") is None

    impulse(tape)
    scanner.tick(tape.now)
    assert "VOLUME_ANOMALY" in event_types(scanner)
    situation = scanner.situation("TST")
    assert situation is not None
    assert situation.state == "NEW"
    assert situation.direction == "bullish"


def test_a_quiet_tape_produces_nothing() -> None:
    scanner, tape = build()
    warm(tape, minutes=40)
    snapshot = scanner.tick(tape.now)
    assert snapshot.situations == []
    assert snapshot.funnel.universe == 1
    assert snapshot.funnel.events == 0


def test_an_event_without_context_or_structure_is_not_surfaced() -> None:
    """The compression rule: an anomaly on its own is data, not a situation."""
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    snapshot = scanner.tick(tape.now)
    situation = scanner.situation("TST")
    assert situation is not None
    assert situation.worth_watching is False
    assert "context_unknown" in situation.reasons or "no_structure" in situation.reasons
    assert snapshot.situations == []
    # …and the funnel explains the empty page rather than leaving it a mystery.
    assert snapshot.funnel.events == 1
    assert snapshot.funnel.surfaced == 0


@pytest.mark.anyio
async def test_an_event_with_context_and_structure_is_surfaced() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    await with_context(scanner, tape, drift=0.02)

    tape.run(4, price=102.0, volume_mult=4.0, trade_mult=4.0)
    snapshot = scanner.tick(tape.now)
    assert symbols(snapshot.situations) == ["TST"]
    entry = snapshot.situations[0]
    assert entry.situation.worth_watching is True
    assert entry.headline is not None
    assert entry.situation.context is not None
    assert snapshot.funnel.surfaced == 1


def test_the_headline_is_an_event_and_pressure_is_only_telemetry() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    situation = scanner.situation("TST")
    assert situation is not None and situation.headline is not None
    assert situation.headline.type == "VOLUME_ANOMALY"
    entry = scanner._entry(situation)
    assert entry is not None
    assert entry.pressure in {"heavy buy pressure", "buyers stepping in"}


def test_a_bearish_impulse_is_detected_symmetrically() -> None:
    scanner, tape = build()
    warm(tape)
    tape.ramp(180, to=98.0, volume_mult=4.0, trade_mult=4.0)
    scanner.tick(tape.now)
    assert scanner.situation("TST").direction == "bearish"  # type: ignore[union-attr]


def test_warming_up_until_the_universe_has_history() -> None:
    scanner, tape = build()
    tape.run(30, price=100.0)
    assert scanner.tick(tape.now).warming_up is True


# ── the developing lifecycle ────────────────────────────────────────────────


@pytest.mark.anyio
async def test_a_retracement_walks_the_situation_into_pullback() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    await with_context(scanner, tape, drift=0.02)

    # Give back ~35% of the leg on cooling volume.
    tape.ramp(60, to=101.3, volume_mult=0.4, trade_mult=0.4)
    scanner.tick(tape.now)
    situation = scanner.situation("TST")
    assert situation is not None
    assert situation.state == "PULLBACK"
    assert situation.pullback is not None
    assert situation.pullback.state == "PULLBACK"
    assert situation.pullback.volume_ratio is not None
    assert situation.pullback.volume_ratio < 1.0
    assert situation.completion is not None


def test_a_round_trip_through_the_origin_invalidates() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)

    tape.ramp(120, to=99.5, volume_mult=3.0, trade_mult=3.0)
    scanner.tick(tape.now)
    situation = scanner.situation("TST")
    assert situation is not None
    assert situation.state == "INVALID"
    assert situation.worth_watching is False
    assert scanner.tick(tape.now).situations == []


def test_the_situation_state_does_not_flip_on_volume_noise() -> None:
    """RVOL swinging around must not move the card between states."""
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    tape.run(int(SCALP.situation.min_state_seconds) + 5, price=102.0, volume_mult=4.0)
    scanner.tick(tape.now)
    state = scanner.situation("TST").state  # type: ignore[union-attr]

    for step in range(6):
        tape.run(4, price=102.0, volume_mult=6.0 if step % 2 else 1.5, trade_mult=4.0)
        scanner.tick(tape.now)
        assert scanner.situation("TST").state == state  # type: ignore[union-attr]


# ── modes ────────────────────────────────────────────────────────────────────


def test_both_modes_run_over_the_same_observations() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    assert scanner.snapshot("SCALP").mode == "SCALP"
    assert scanner.snapshot("INTRADAY").mode == "INTRADAY"
    # One store, one metrics sweep, two horizons.
    assert scanner.snapshot("INTRADAY").universe_size == scanner.snapshot("SCALP").universe_size


def test_a_small_burst_displaces_the_scalp_window_but_not_the_intraday_one() -> None:
    """+0.9% in three minutes is the whole move for a scalper and a ripple on
    the 15m window — the reason the two modes cannot share a threshold."""
    scanner, tape = build()
    warm(tape)
    tape.ramp(180, to=100.9, volume_mult=4.0, trade_mult=4.0)
    scanner.tick(tape.now)

    assert "PRICE_DISPLACEMENT" in event_types(scanner, mode="SCALP")
    assert "PRICE_DISPLACEMENT" not in event_types(scanner, mode="INTRADAY")


def test_an_unknown_mode_degrades_to_scalp() -> None:
    scanner, tape = build()
    warm(tape)
    scanner.tick(tape.now)
    assert scanner.snapshot("nonsense").mode == "SCALP"


# ── funnel + stability ───────────────────────────────────────────────────────


def test_the_funnel_reports_every_stage() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    funnel = scanner.tick(tape.now).funnel
    assert funnel.universe == 1
    assert funnel.tracked == 1
    assert funnel.events == 1
    assert funnel.directional == 1
    assert funnel.surfaced <= funnel.events


@pytest.mark.anyio
async def test_surfacing_is_capped_however_many_symbols_fire() -> None:
    store = MarketStateStore()
    cache = ContextCache(fetcher=_StubKlines(0.02))
    scanner = MomentumScanner(store, MomentumIngestor(store), context_cache=cache)
    tapes = [Tape(store, symbol=f"T{i:02d}") for i in range(SCALP.situation.max_surfaced + 6)]
    for tape in tapes:
        warm(tape)
        impulse(tape)
    scanner.tick(tapes[0].now)
    cache.track([t.symbol for t in tapes], tapes[0].now)
    for _ in range(6):
        await cache.refresh_once(tapes[0].now)

    for tape in tapes:
        tape.run(4, price=102.0, volume_mult=4.0, trade_mult=4.0)
    snapshot = scanner.tick(tapes[0].now)
    assert len(snapshot.situations) <= SCALP.situation.max_surfaced


def test_revision_advances_every_tick() -> None:
    scanner, tape = build()
    warm(tape)
    before = scanner.revision
    scanner.tick(tape.now)
    scanner.tick(tape.now + 1)
    assert scanner.revision == before + 2


def test_the_scan_tick_never_fetches_context_itself() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    assert "TST" in scanner.context_cache._interest
    assert scanner.context_cache.refreshes == 0


# ── the journal ──────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_a_developing_situation_is_journaled() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    await with_context(scanner, tape, drift=0.02)

    tape.ramp(60, to=101.3, volume_mult=0.4, trade_mult=0.4)
    scanner.tick(tape.now)
    rows = scanner.journal("SCALP").recent()
    assert rows
    row = rows[0]
    assert row.symbol == "TST"
    assert row.direction == "bullish"
    assert row.trigger_type != ""
    assert row.outcome == "OPEN"


def test_nothing_is_journaled_for_a_card_that_never_develops() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    assert scanner.journal("SCALP").recent() == []


# ── API surface ──────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_scan_endpoint_returns_the_envelope(client: AsyncClient) -> None:
    response = await client.get("/api/v1/momentum/scan")
    assert response.status_code == 200
    data = response.json()["data"]
    assert set(data) >= {
        "updated_at",
        "mode",
        "version",
        "events_version",
        "context_version",
        "journal_version",
        "universe_size",
        "tracked",
        "connected",
        "warming_up",
        "funnel",
        "situations",
        "closed",
        "counts",
    }
    assert set(data["funnel"]) == {
        "universe",
        "tracked",
        "events",
        "qualified",
        "directional",
        "structural",
        "developing",
        "surfaced",
    }


@pytest.mark.anyio
async def test_scan_endpoint_serves_each_mode(client: AsyncClient) -> None:
    for mode in ("SCALP", "INTRADAY", "SWING"):
        response = await client.get(f"/api/v1/momentum/scan?mode={mode}")
        assert response.status_code == 200
        assert response.json()["data"]["mode"] == mode
    # An unknown mode degrades rather than erroring.
    fallback = await client.get("/api/v1/momentum/scan?mode=nonsense")
    assert fallback.json()["data"]["mode"] == "SCALP"


@pytest.mark.anyio
async def test_modes_endpoint_describes_each_horizon(client: AsyncClient) -> None:
    response = await client.get("/api/v1/momentum/modes")
    assert response.status_code == 200
    rows = {row["mode"]: row for row in response.json()["data"]}
    assert rows["SCALP"]["events"] == ["1m", "3m"]
    assert rows["INTRADAY"]["events"] == ["5m", "15m"]
    assert "4H" in rows["INTRADAY"]["context"]
    assert "4H" not in rows["SCALP"]["context"]
    # Swing shares the trigger windows (the tick store cannot go slower) and
    # differs by context.
    assert rows["SWING"]["events"] == ["5m", "15m"]
    assert "1D" in rows["SWING"]["context"]


@pytest.mark.anyio
async def test_journal_endpoint_returns_stats_and_rows(client: AsyncClient) -> None:
    response = await client.get("/api/v1/momentum/journal")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["mode"] == "SCALP"
    assert "recorded" in data["stats"]
    assert isinstance(data["entries"], list)


@pytest.mark.anyio
async def test_timeline_endpoint_is_empty_for_an_untracked_symbol(client: AsyncClient) -> None:
    response = await client.get("/api/v1/momentum/timeline/NOPE")
    assert response.status_code == 200
    assert response.json()["data"]["events"] == []


# ── selectivity end to end ───────────────────────────────────────────────────


def test_a_move_without_participation_is_not_a_situation() -> None:
    """+2% on ordinary volume produces observations and no qualified
    relationship — so nothing reaches the page."""
    scanner, tape = build()
    warm(tape)
    tape.ramp(180, to=102.0)
    snapshot = scanner.tick(tape.now)
    situation = scanner.situation("TST")
    assert situation is not None
    assert situation.qualification.qualified is False
    assert situation.worth_watching is False
    assert "unqualified" in situation.reasons
    assert snapshot.situations == []
    assert snapshot.funnel.qualified == 0


def test_a_move_with_participation_qualifies() -> None:
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    snapshot = scanner.tick(tape.now)
    situation = scanner.situation("TST")
    assert situation is not None
    assert situation.qualification.qualified is True
    assert situation.qualification.combo == "displacement+participation"
    assert snapshot.funnel.qualified == 1


def test_scores_no_longer_pin_to_the_top_of_the_scale() -> None:
    """Everything reading 95-100 was the old scoring's tell. A score now needs
    several independent families to get near the top."""
    scanner, tape = build()
    warm(tape)
    impulse(tape)
    scanner.tick(tape.now)
    situation = scanner.situation("TST")
    assert situation is not None
    assert 0 < situation.score < 90
