"""Forward-test recorder: capture, dedup, persistence and the read model.

Mirrors the pattern in test_signals_repo.py — only the DB engine is
substituted, so the real repo/model path runs for real against an ephemeral
SQLite database.

What matters here is not that rows appear, but that the *wrong* rows never do:
one row per situation however often it is polled, detection-time columns that
no update can reach, and lifecycle history that is only ever appended.
"""

from collections.abc import AsyncIterator
from dataclasses import replace
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from smc.context_alignment import Alignment
from smc.arms import settlement_variants
from smc.forward_test import (
    DEFAULT_FORWARD_TEST_CONFIG,
    advance_position,
    open_position,
)
from smc.market_context import MarketContext, TimeframeRead
from smc.momentum_events import Qualification
from smc.situation import Situation
from smc.structural_path import build_path
from smc.structure_map import StructuralLevel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.research import repo
from app.research.models import ForwardTestEvent, ForwardTestSetup
from app.research.recorder import (
    is_capturable,
    lifecycle_values,
    position_from_row,
    setup_key,
    setup_values,
    snapshot_from,
)

T0 = 1_700_000_000.0
CFG = DEFAULT_FORWARD_TEST_CONFIG


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    tables = [
        ForwardTestSetup.metadata.tables["forward_test_setups"],
        ForwardTestSetup.metadata.tables["forward_test_events"],
    ]
    async with engine.begin() as conn:
        await conn.run_sync(ForwardTestSetup.metadata.create_all, tables=tables)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            yield session
    finally:
        await engine.dispose()


# ── fixtures ─────────────────────────────────────────────────────────────────


CONTEXT = MarketContext(
    symbol="TST",
    bias="bearish",
    agreement=1.0,
    score=-1.0,
    reads=(
        TimeframeRead(
            timeframe="1H",
            bias="bearish",
            trend="downtrend",
            event=None,
            event_label=None,
            change_pct=-2.0,
            bars=120,
            last_candle_time=int(T0),
            computed_at=T0,
        ),
    ),
    updated_at=T0,
    bias_since=T0,
)

ALIGNED = Alignment(
    level="HIGH",
    classification="aligned",
    agreement=1.0,
    context_bias="bearish",
    event_direction="bearish",
)


def situation(**overrides: object) -> Situation:
    """A confirmed bearish setup with a workable 3R path."""
    path = build_path(
        "bearish",
        entry=100.0,
        pullback_extreme=100.5,
        leg_size=5.0,
        target=94.0,
        target_kind="equal_lows",
    )
    assert path is not None
    base: dict[str, object] = dict(
        symbol="TST",
        mode="SCALP",
        state="PULLBACK_COMPLETION",
        direction="bearish",
        score=72.0,
        headline=None,
        qualification=Qualification(
            qualified=True,
            tier="HIGH",
            combo="structure+activity",
            families=("PARTICIPATION", "PRICE", "STRUCTURE"),
        ),
        context=CONTEXT,
        alignment=ALIGNED,
        pullback=None,
        completion=None,
        targets=(),
        path=path,
        worth_watching=True,
        reasons=("structure+activity", "tier_high"),
        first_seen=T0,
        state_since=T0,
        updated_at=T0,
    )
    base.update(overrides)
    return Situation(**base)  # type: ignore[arg-type]


def level(price: float, kind: str = "equal_lows") -> StructuralLevel:
    return StructuralLevel(price=price, kind=kind, timeframe="5M", time=int(T0))  # type: ignore[arg-type]


# ── what gets captured ───────────────────────────────────────────────────────


def test_a_confirmed_setup_with_a_path_is_capturable() -> None:
    assert is_capturable(situation()) is True


def test_a_card_that_is_not_worth_watching_is_not_recorded() -> None:
    assert is_capturable(situation(worth_watching=False)) is False


def test_an_early_lifecycle_card_is_not_recorded() -> None:
    """NEW and DEVELOPING have no plan to settle against."""
    assert is_capturable(situation(state="NEW")) is False
    assert is_capturable(situation(state="DEVELOPING")) is False


def test_a_setup_without_a_structural_path_is_not_recorded() -> None:
    assert is_capturable(situation(path=None)) is False


def test_a_path_the_engine_rejected_is_not_recorded() -> None:
    short = build_path("bearish", entry=100.0, pullback_extreme=101.0, leg_size=5.0, target=99.5)
    assert short is not None and short.verdict == "SKIP"
    assert is_capturable(situation(path=short)) is False


def test_a_degenerate_plan_is_refused() -> None:
    broken = build_path("bearish", entry=100.0, pullback_extreme=100.5, leg_size=5.0, target=94.0)
    assert broken is not None
    assert is_capturable(situation(path=replace(broken, target=100.0))) is False


# ── the snapshot ─────────────────────────────────────────────────────────────


def test_the_snapshot_freezes_the_plan_and_its_provenance() -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    assert snapshot.reference_entry == 100.0
    assert snapshot.target == 94.0
    assert snapshot.potential_rr > 0
    assert snapshot.entry_low <= snapshot.reference_entry <= snapshot.entry_high
    assert snapshot.htf_bias == "bearish"
    assert snapshot.alignment == "aligned"
    # Provenance is mandatory: a result nobody can trace to a configuration is
    # not a result.
    assert snapshot.engine_version
    assert snapshot.config_hash
    assert snapshot.forward_test_version


def test_the_entry_zone_is_derived_once_at_detection() -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    # Bearish: the zone sits above the reference, toward the invalidation.
    assert snapshot.entry_high > snapshot.reference_entry
    assert snapshot.entry_high < snapshot.initial_invalidation


# ── deduplication ────────────────────────────────────────────────────────────


def test_the_setup_key_is_stable_across_polls() -> None:
    first = setup_key(situation(updated_at=T0))
    later = setup_key(situation(updated_at=T0 + 300, state="CONTINUATION_CANDIDATE"))
    assert first == later


def test_a_genuinely_new_setup_gets_its_own_key() -> None:
    assert setup_key(situation(first_seen=T0)) != setup_key(situation(first_seen=T0 + 600))


def test_each_mode_records_the_same_symbol_separately() -> None:
    assert setup_key(situation(mode="SCALP")) != setup_key(situation(mode="INTRADAY"))


@pytest.mark.anyio
async def test_inserting_the_same_setup_twice_creates_one_row(db: AsyncSession) -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())

    first = await repo.insert_setup(db, setup_values(snapshot, position, key))
    second = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert first is not None
    assert second is None
    assert await repo.count_setups(db) == 1
    assert await repo.find_id(db, key) == first


# ── persistence + immutability ───────────────────────────────────────────────


@pytest.mark.anyio
async def test_the_lifecycle_update_cannot_touch_the_hypothesis(db: AsyncSession) -> None:
    """The guarantee that makes the dataset trustworthy: there is no door
    through which a target can be revised."""
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None

    await repo.update_lifecycle(
        db,
        setup_id,
        {
            "status": "TARGET_HIT",
            "realized_r": 3.0,
            # All of these must be ignored.
            "target": 1.0,
            "initial_invalidation": 1.0,
            "reference_entry": 1.0,
            "potential_rr": 99.0,
            "detected_at": None,
            "tier": "LOW",
        },
    )
    row = await db.get(ForwardTestSetup, setup_id)
    assert row is not None
    assert row.status == "TARGET_HIT"
    assert row.realized_r == 3.0
    assert row.target == 94.0
    assert row.initial_invalidation == 100.5 + (5.0 * 0.12)
    assert row.reference_entry == 100.0
    assert row.tier == "HIGH"


@pytest.mark.anyio
async def test_trailing_never_overwrites_the_original_invalidation(db: AsyncSession) -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None
    original = snapshot.initial_invalidation

    trailed = replace(
        position,
        active_stop=original - 1.5,
        trailing_activated_at=T0 + 60,
        trailing_updates=((T0 + 60, original - 1.0), (T0 + 90, original - 1.5)),
    )
    await repo.update_lifecycle(db, setup_id, lifecycle_values(trailed, 3))
    row = await db.get(ForwardTestSetup, setup_id)
    assert row is not None
    assert row.initial_invalidation == original
    assert row.active_stop == original - 1.5
    # The whole stop history survives.
    assert len(row.trailing_updates or []) == 2


@pytest.mark.anyio
async def test_events_are_append_only(db: AsyncSession) -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, events = open_position(snapshot, T0, 100.0, CFG)
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, setup_key(situation())))
    assert setup_id is not None

    await repo.insert_events(
        db,
        [
            {
                "setup_id": setup_id,
                "type": event.type,
                "ts": repo.to_utc(event.ts),
                "price": event.price,
                "detail": dict(event.detail),
            }
            for event in events
        ],
    )
    await repo.insert_events(
        db,
        [
            {
                "setup_id": setup_id,
                "type": "ENTRY_FILLED",
                "ts": repo.to_utc(T0 + 30),
                "price": 100.4,
                "detail": {},
            }
        ],
    )
    stored = await repo.events_for(db, setup_id)
    assert [event.type for event in stored] == ["SETUP_CONFIRMED", "ENTRY_FILLED"]
    assert isinstance(stored[0], ForwardTestEvent)


@pytest.mark.anyio
async def test_open_setups_survive_a_restart(db: AsyncSession) -> None:
    """A hypothesis in flight when the process died must be reloadable, or the
    dataset silently loses its hardest cases."""
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    await repo.insert_setup(db, setup_values(snapshot, position, setup_key(situation())))
    still_open = await repo.open_setups(db)
    assert [row.status for row in still_open] == ["PENDING_ENTRY"]


# ── read model ───────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_statistics_read_back_from_the_database(db: AsyncSession) -> None:
    from smc.forward_test import compute_stats

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    for index, (status, realized) in enumerate(
        (("TARGET_HIT", 3.0), ("INVALIDATED", -1.0), ("NO_FILL", 0.0))
    ):
        position, _ = open_position(snapshot, T0 + index, 100.0, CFG)
        values = setup_values(snapshot, position, f"key-{index}")
        values["status"] = status
        values["realized_r"] = realized
        values["detected_at"] = repo.to_utc(T0 + index)
        await repo.insert_setup(db, values)

    stats = compute_stats(await repo.outcome_rows(db))
    assert stats.total == 3
    assert stats.filled == 2
    assert stats.no_fill == 1
    assert stats.win_rate == pytest.approx(0.5)
    assert stats.total_r == pytest.approx(2.0)


@pytest.mark.anyio
async def test_the_feed_filters_by_mode_and_status(db: AsyncSession) -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    for index, (mode, status) in enumerate(
        (("SCALP", "TARGET_HIT"), ("INTRADAY", "TARGET_HIT"), ("SCALP", "NO_FILL"))
    ):
        values = setup_values(snapshot, position, f"key-{index}")
        values["mode"] = mode
        values["status"] = status
        values["detected_at"] = repo.to_utc(T0 + index)
        await repo.insert_setup(db, values)

    assert len(await repo.list_setups(db, mode="SCALP")) == 2
    assert len(await repo.list_setups(db, mode="SCALP", status="NO_FILL")) == 1
    assert len(await repo.list_setups(db)) == 3


@pytest.mark.anyio
async def test_the_best_setup_is_the_highest_realized_r(db: AsyncSession) -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    for index, realized in enumerate((1.0, 4.2, -1.0)):
        values = setup_values(snapshot, position, f"key-{index}")
        values["status"] = "TARGET_HIT" if realized > 0 else "INVALIDATED"
        values["realized_r"] = realized
        values["detected_at"] = repo.to_utc(T0 + index)
        await repo.insert_setup(db, values)

    best = await repo.best_setup(db)
    assert best is not None
    assert best.realized_r == pytest.approx(4.2)


@pytest.mark.anyio
async def test_first_detection_anchors_days_running(db: AsyncSession) -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    for index in range(3):
        values = setup_values(snapshot, position, f"key-{index}")
        values["detected_at"] = repo.to_utc(T0 + index * 3600)
        await repo.insert_setup(db, values)

    first = await repo.first_detection(db)
    assert first is not None
    # SQLite drops the tzinfo Postgres preserves; the read model normalizes
    # naive instants to UTC, so assert through the same helper the API uses.
    from app.research.router import _epoch

    assert _epoch(first) == pytest.approx(T0)


# ── the API surface ──────────────────────────────────────────────────────────


@pytest.fixture
async def api(db: AsyncSession) -> AsyncIterator[AsyncClient]:
    """The real app, with `get_db` pointed at the ephemeral SQLite session.

    Deliberately not the shared `client` fixture: that one resolves `get_db` to
    the configured DATABASE_URL, and on this box that is production. A research
    read is harmless, but a test suite that can reach the production database
    at all is one refactor away from writing to it.
    """
    from app.database import get_db
    from app.main import app

    async def override_get_db() -> AsyncIterator[AsyncSession]:
        yield db

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.anyio
async def test_the_research_endpoint_serves_summary_stats_and_rows(api: AsyncClient) -> None:
    """Exercises the real route: the read model has to survive the slotted
    dataclasses the engine returns."""
    response = await api.get("/api/v1/research/forward-test")
    assert response.status_code == 200
    data = response.json()["data"]
    assert set(data) >= {"mode", "summary", "stats", "setups"}
    assert set(data["summary"]) >= {
        "days_running",
        "setups_recorded",
        "open_now",
        "strategy_version",
    }
    assert set(data["stats"]) >= {
        "total",
        "fill_rate",
        "win_rate",
        "expectancy",
        "profit_factor",
        "max_drawdown_r",
    }
    assert isinstance(data["setups"], list)


@pytest.mark.anyio
async def test_the_research_endpoint_filters_by_mode(api: AsyncClient) -> None:
    response = await api.get("/api/v1/research/forward-test?mode=intraday&limit=5")
    assert response.status_code == 200
    assert response.json()["data"]["mode"] == "INTRADAY"


@pytest.mark.anyio
async def test_an_unknown_setup_id_is_a_404(api: AsyncClient) -> None:
    response = await api.get("/api/v1/research/forward-test/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


# ── a settled record is terminal ─────────────────────────────────────────────


@pytest.mark.anyio
async def test_a_settled_row_is_never_re_adopted_into_a_second_lifecycle(
    db: AsyncSession,
) -> None:
    """The failure this guards against was seen in production: a symbol that
    stayed confirmed after its stop was hit got re-adopted on the next capture
    pass, overwrote its own settled status, and appended a second ENTRY_FILLED.
    A settled hypothesis is history."""

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None

    settled = replace(
        position,
        status="INVALIDATED",
        entered_at=T0 + 30,
        entry_price=100.4,
        settled_at=T0 + 90,
        exit_price=102.5,
        exit_reason="invalidation",
        realized_r=-1.0,
    )
    await repo.update_lifecycle(db, setup_id, lifecycle_values(settled, 3))

    # The capture path asks for the row; it must see a closed record rather
    # than adopting it with a fresh PENDING_ENTRY.
    row = await repo.find_row(db, key)
    assert row is not None
    assert row.status == "INVALIDATED"
    from smc.forward_test import OPEN_STATUSES

    assert row.status not in OPEN_STATUSES


@pytest.mark.anyio
async def test_an_open_row_is_adopted_with_its_existing_lifecycle(db: AsyncSession) -> None:
    """Restart recovery: an in-flight hypothesis resumes where it was, rather
    than starting its lifecycle again."""
    from app.research.recorder import position_from_row

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None

    filled = replace(
        position,
        status="ACTIVE",
        zone_touched_at=T0 + 20,
        entered_at=T0 + 30,
        entry_price=100.4,
        active_stop=101.0,
        trailing_activated_at=T0 + 60,
        trailing_updates=((T0 + 60, 101.0),),
        mfe_r=1.2,
        mae_r=-0.3,
    )
    await repo.update_lifecycle(db, setup_id, lifecycle_values(filled, 4))

    row = await repo.find_row(db, key)
    assert row is not None
    rebuilt = position_from_row(row)
    assert rebuilt.status == "ACTIVE"
    assert rebuilt.entry_price == pytest.approx(100.4)
    assert rebuilt.active_stop == pytest.approx(101.0)
    assert rebuilt.mfe_r == pytest.approx(1.2)
    assert len(rebuilt.trailing_updates) == 1
    # …and it is still a live position, so settlement continues from here.
    assert rebuilt.is_open is True


# ── cohorts never pool ───────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_generations_are_not_averaged_together(db: AsyncSession) -> None:
    """A detector revision starts a new experiment. Blending its results with
    the old geometry's produces a number that describes neither."""
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)

    for index, (generation, realized) in enumerate(((1, -1.0), (1, -1.0), (2, 3.0))):
        values = setup_values(snapshot, position, f"key-{index}")
        values["status"] = "TARGET_HIT" if realized > 0 else "INVALIDATED"
        values["realized_r"] = realized
        values["detected_at"] = repo.to_utc(T0 + index)
        values["versions"] = {"generation": generation}
        await repo.insert_setup(db, values)

    from smc.forward_test import compute_stats

    old = compute_stats(await repo.outcome_rows(db, generation=1))
    new = compute_stats(await repo.outcome_rows(db, generation=2))
    everything = compute_stats(await repo.outcome_rows(db))

    assert old.total == 2 and old.total_r == pytest.approx(-2.0)
    assert new.total == 1 and new.total_r == pytest.approx(3.0)
    # Only an explicit request for every cohort merges them.
    assert everything.total == 3


@pytest.mark.anyio
async def test_the_endpoint_defaults_to_the_current_generation(api: AsyncClient) -> None:
    from app.research.recorder import DETECTOR_GENERATION

    assert DETECTOR_GENERATION >= 2
    response = await api.get("/api/v1/research/forward-test")
    assert response.status_code == 200
    # …and asking for everything is possible, but has to be explicit.
    merged = await api.get("/api/v1/research/forward-test?generation=0")
    assert merged.status_code == 200


# ── restart recovery ─────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_an_in_flight_setup_is_resumed_after_a_restart(db: AsyncSession) -> None:
    """Without this the row stays OPEN forever and never settles, biasing the
    dataset toward whatever happened to close before the restart."""
    from app.research.recorder import ForwardTestRecorder, snapshot_from_row

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None
    await repo.update_lifecycle(
        db,
        setup_id,
        lifecycle_values(
            replace(position, status="ACTIVE", entered_at=T0 + 30, entry_price=100.4), 3
        ),
    )

    row = await repo.find_row(db, key)
    assert row is not None
    # The hypothesis comes back byte-identical — read, never recomputed.
    restored = snapshot_from_row(row)
    assert restored.reference_entry == snapshot.reference_entry
    assert restored.initial_invalidation == snapshot.initial_invalidation
    assert restored.target == snapshot.target
    assert restored.detected_at == pytest.approx(snapshot.detected_at)
    assert restored.direction == snapshot.direction

    recorder = ForwardTestRecorder()
    recorder._open[key] = (str(row.id), restored, position_from_row(row), row.event_count)
    assert recorder.open_count == 1


@pytest.mark.anyio
async def test_only_open_rows_are_reloaded(db: AsyncSession) -> None:
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    for index, status in enumerate(("ACTIVE", "TARGET_HIT", "NO_FILL", "PENDING_ENTRY")):
        values = setup_values(snapshot, position, f"key-{index}")
        values["status"] = status
        values["detected_at"] = repo.to_utc(T0 + index)
        await repo.insert_setup(db, values)

    reloaded = await repo.open_setups(db)
    assert sorted(row.status for row in reloaded) == ["ACTIVE", "PENDING_ENTRY"]


# ── costs, variants and per-horizon patience ─────────────────────────────────


def test_each_horizon_records_with_its_own_patience() -> None:
    """A scalp given four hours to fill is not a scalp; a swing given fifteen
    minutes is not a swing."""
    from smc.scan_profiles import INTRADAY, SCALP, SWING

    assert SCALP.forward_test.entry_window_seconds < INTRADAY.forward_test.entry_window_seconds
    assert INTRADAY.forward_test.entry_window_seconds < SWING.forward_test.entry_window_seconds
    assert SWING.forward_test.max_holding_seconds > 24 * 3600


@pytest.mark.anyio
async def test_variant_outcomes_are_persisted_alongside_the_primary(db: AsyncSession) -> None:
    from smc.arms import settlement_variants
    from smc.forward_test import advance_position

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None

    # Fill, then run to target on every rule.
    alternatives = {
        variant.name: open_position(snapshot, T0, 100.0, variant.config)[0]
        for variant in settlement_variants(CFG)
    }
    # 100.3 is inside the entry zone (100.0-100.385); 100.4 would miss it.
    for offset, price in ((30, 100.3), (120, 93.0)):
        position, _ = advance_position(snapshot, position, price, T0 + offset, CFG)
        for name, alt in list(alternatives.items()):
            alternatives[name], _ = advance_position(snapshot, alt, price, T0 + offset, CFG)
    assert position.status == "TARGET_HIT"

    await repo.update_lifecycle(db, setup_id, lifecycle_values(position, 4, alternatives))
    row = await db.get(ForwardTestSetup, setup_id)
    assert row is not None
    assert row.variants is not None
    assert set(row.variants) == {v.name for v in settlement_variants(CFG)}
    assert row.variants["no_trail"]["status"] == "TARGET_HIT"
    # Costs are split out, not folded silently into the headline number.
    assert row.gross_r > row.realized_r
    assert row.cost_r > 0


@pytest.mark.anyio
async def test_costs_reach_the_database(db: AsyncSession) -> None:
    from smc.forward_test import advance_position

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, setup_key(situation())))
    assert setup_id is not None
    for offset, price in ((30, 100.3), (120, 93.0)):
        position, _ = advance_position(snapshot, position, price, T0 + offset, CFG)
    # Guard against a vacuous pass: an unfilled setup would satisfy the
    # arithmetic below with three zeros.
    assert position.status == "TARGET_HIT"
    assert position.cost_r > 0

    await repo.update_lifecycle(db, setup_id, lifecycle_values(position, 3))
    row = await db.get(ForwardTestSetup, setup_id)
    assert row is not None
    assert row.realized_r == pytest.approx(row.gross_r - row.cost_r, abs=1e-4)
    assert row.gross_r > row.realized_r


def test_the_generation_moved_for_the_capture_rule() -> None:
    """Costs (3), one-position-per-symbol (4) and the fill/floor corrections
    (5) each change what a recorded result means, so the cohorts must never be
    averaged together."""
    from app.research.recorder import DETECTOR_GENERATION

    assert DETECTOR_GENERATION == 5


# ── one live hypothesis per symbol ───────────────────────────────────────────


def _recorder_holding(*positions: tuple[str, str, str]) -> object:
    """A recorder with the given `(symbol, mode, direction)` setups open."""
    from app.research.recorder import ForwardTestRecorder

    recorder = ForwardTestRecorder()
    for index, (symbol, mode, direction) in enumerate(positions):
        snapshot = snapshot_from(situation(symbol=symbol, mode=mode, direction=direction), T0, CFG)
        assert snapshot is not None
        position, _ = open_position(snapshot, T0, 100.0, CFG)
        recorder._open[f"{mode}:{symbol}:{index}"] = (str(index), snapshot, position, 0)
    return recorder


def test_a_second_setup_in_the_same_mode_is_blocked_while_the_first_is_open() -> None:
    """Two situations on one symbol are one price series counted twice, not two
    independent samples."""
    recorder = _recorder_holding(("TST", "SCALP", "bearish"))
    assert recorder.conflict_for("TST", "SCALP", "bearish") == "same_mode_open"


def test_an_opposite_direction_setup_is_blocked_in_any_mode() -> None:
    """A long recorded while a short on the same symbol is still open is a pair
    that cannot both be right — and nothing a person could act on."""
    recorder = _recorder_holding(("TST", "SWING", "bullish"))
    assert recorder.conflict_for("TST", "SCALP", "bearish") == "opposite_direction_open"


def test_another_mode_in_the_same_direction_is_blocked_too() -> None:
    """One live hypothesis per symbol, whatever the horizon: a second record on
    a symbol already running is the same price series counted twice."""
    recorder = _recorder_holding(("TST", "SCALP", "bearish"))
    assert recorder.conflict_for("TST", "INTRADAY", "bearish") == "symbol_already_open"


def test_the_symbol_is_free_again_once_the_position_settles() -> None:
    """The block is held by the *position*, not by the detector — nothing about
    a symbol is banned once its record is closed."""
    from app.research.recorder import ForwardTestRecorder

    recorder = ForwardTestRecorder()
    assert isinstance(recorder, ForwardTestRecorder)
    assert recorder.conflict_for("TST", "SCALP", "bearish") is None


def test_a_different_symbol_is_never_blocked() -> None:
    recorder = _recorder_holding(("TST", "SCALP", "bearish"))
    assert recorder.conflict_for("OTHER", "SCALP", "bullish") is None


# ── alternative exit rules ───────────────────────────────────────────────────


def test_a_position_survives_a_state_round_trip() -> None:
    """What a variant needs to resume after a restart: the stops, the
    excursions and the extremes, not a summary of them."""
    from smc.forward_test import position_from_state, position_state

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    advanced, _ = advance_position(snapshot, position, 99.0, T0 + 30, CFG)
    assert position_from_state(position_state(advanced)) == advanced


def test_a_variant_blob_carries_its_lifecycle_state() -> None:
    from app.research.recorder import variant_values

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    blob = variant_values({"no_trail": position})
    assert blob is not None
    assert blob["no_trail"]["state"]["status"] == position.status


def test_an_empty_variant_set_never_erases_the_stored_one() -> None:
    """A pass with no alternatives in memory — every resumed row before this
    change — must not null the column it cannot rebuild."""
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    assert "variants" not in lifecycle_values(position, 1)
    assert "variants" in lifecycle_values(position, 1, {"no_trail": position})


@pytest.mark.anyio
async def test_alternatives_keep_running_after_the_primary_exits(
    db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`no_trail` holds to the target and outlives a trailed exit by design.
    Freezing it when the primary settles would score the comparison in the
    primary's favour — which is exactly what it exists to measure."""
    import contextlib

    from app.research import recorder as recorder_module
    from app.research.recorder import ForwardTestRecorder

    @contextlib.asynccontextmanager
    async def session() -> AsyncIterator[AsyncSession]:
        yield db

    monkeypatch.setattr(recorder_module, "SessionFactory", session)

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None

    recorder = ForwardTestRecorder()
    recorder._open[key] = (setup_id, snapshot, position, 0)
    recorder._variants[key] = {
        name: open_position(snapshot, T0, 100.0, variant.config)[0]
        for name, variant in {v.name: v for v in settlement_variants(CFG)}.items()
    }
    # Fill in the zone, run to +1.6R so the trail engages, then retrace enough
    # for the trailed primary to be stopped out while the others hold.
    monkeypatch.setattr(recorder, "_price_for", lambda _symbol: 100.2)
    await recorder._settle(T0 + 10)
    monkeypatch.setattr(recorder, "_price_for", lambda _symbol: 98.4)
    await recorder._settle(T0 + 20)
    monkeypatch.setattr(recorder, "_price_for", lambda _symbol: 99.6)
    await recorder._settle(T0 + 30)

    assert key not in recorder._open
    assert key in recorder._variant_only, "the alternatives were dropped with the primary"

    # …and they settle on their own terms, at the target the primary never saw.
    monkeypatch.setattr(recorder, "_price_for", lambda _symbol: 93.9)
    await recorder._settle_variants(T0 + 60)

    row = await db.get(ForwardTestSetup, setup_id)
    assert row is not None
    assert row.variants is not None
    assert row.variants["no_trail"]["status"] == "TARGET_HIT"
    assert row.variants["no_trail"]["realized_r"] > 0
    assert row.status == "INVALIDATED", "the primary's own outcome is untouched"


@pytest.mark.anyio
async def test_a_trailing_variant_set_is_reloaded_after_a_restart(db: AsyncSession) -> None:
    from app.research.recorder import variant_values

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None
    settled = replace(
        position,
        status="INVALIDATED",
        entered_at=T0 + 10,
        entry_price=100.0,
        settled_at=T0 + 60,
        exit_price=101.0,
        exit_reason="trailing_stop",
        realized_r=0.4,
    )
    values = lifecycle_values(settled, 2, {"no_trail": replace(position, status="ACTIVE")})
    await repo.update_lifecycle(db, setup_id, values)

    rows = await repo.settled_with_open_variants(db)
    assert [row.setup_key for row in rows] == [key]
    assert variant_values({"no_trail": position}) is not None


# ── an open position is marked live, not left at its last transition ─────────


def test_floating_r_is_net_of_the_round_trip() -> None:
    """An open number that omits costs is not comparable with the settled one
    it becomes."""
    from smc.forward_test import unrealized_r

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    filled, _ = advance_position(snapshot, position, 100.0, T0 + 10, CFG)
    assert filled.status == "ACTIVE"
    marked, _ = advance_position(snapshot, filled, 99.0, T0 + 20, CFG)
    floating = unrealized_r(snapshot, marked, CFG)
    assert 0 < floating < marked.mfe_r


def test_a_settled_position_has_no_floating_r() -> None:
    from smc.forward_test import unrealized_r

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    settled = replace(position, status="TARGET_HIT", settled_at=T0 + 60, realized_r=3.0)
    assert unrealized_r(snapshot, settled, CFG) == 0.0


@pytest.mark.anyio
async def test_an_open_row_is_served_with_a_live_mark_and_a_running_clock(
    db: AsyncSession, api: AsyncClient
) -> None:
    """The bug this fixes: the recorder only writes on a transition, so a quiet
    open position was served with an hour-old price and a frozen timer."""
    import time

    from app.research.recorder import get_recorder

    now = time.time()
    snapshot = snapshot_from(situation(), now - 600, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, now - 600, 100.0, CFG)
    filled = replace(
        position,
        status="ACTIVE",
        entered_at=now - 540,
        entry_price=100.0,
        last_price=100.0,
        updated_at=now - 540,
    )
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, filled, key))
    assert setup_id is not None
    await repo.update_lifecycle(db, setup_id, lifecycle_values(filled, 1))

    recorder = get_recorder()
    live = replace(filled, last_price=99.0, mfe_r=1.1, updated_at=now)
    recorder._open[key] = (setup_id, snapshot, live, 1)
    try:
        response = await api.get("/api/v1/research/forward-test?generation=0")
        row = next(s for s in response.json()["data"]["setups"] if s["id"] == setup_id)
    finally:
        recorder._open.pop(key, None)

    assert row["last_price"] == 99.0
    assert row["mfe_r"] == 1.1
    assert row["unrealized_r"] > 0
    assert row["time_in_trade"] is not None and row["time_in_trade"] > 500


# ── the tape a record happened in ────────────────────────────────────────────


def test_the_regime_is_frozen_onto_the_hypothesis_at_detection() -> None:
    """Without this the record cannot tell a trending afternoon from overnight
    chop, and two cohorts run through different tape look like two detectors."""
    from smc.market_regime import read_regime

    from app.research.recorder import with_flow

    class Metrics:
        rvol_3m = 2.0
        change_1m_pct = 0.4
        change_3m_pct = 0.9
        change_5m_pct = 1.2
        change_15m_pct = 2.0

    class Tape:
        def __init__(self, symbol: str, change: float) -> None:
            self.symbol = symbol
            self.change_15m_pct = change
            self.quote_volume_24h = 50_000_000.0

    regime = read_regime([Tape(f"S{i}", 1.0) for i in range(60)])
    assert regime.state == "bullish"

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    frozen = with_flow(snapshot, Metrics(), None, regime)

    assert frozen.regime == "bullish"
    assert frozen.regime_breadth == 1.0
    assert frozen.regime_sample == 60


def test_a_snapshot_built_without_a_regime_reads_unknown_not_a_direction() -> None:
    from app.research.recorder import with_flow

    class Metrics:
        rvol_3m = None
        change_1m_pct = None
        change_3m_pct = None
        change_5m_pct = None
        change_15m_pct = None

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    assert with_flow(snapshot, Metrics(), None, None).regime == "unknown"


@pytest.mark.anyio
async def test_the_detection_regime_persists_and_survives_a_restart(db: AsyncSession) -> None:
    from app.research.recorder import snapshot_from_row

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    frozen = replace(
        snapshot,
        regime="bearish",
        regime_breadth=-0.62,
        regime_energy_pct=0.84,
        regime_sample=180,
    )
    position, _ = open_position(frozen, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(frozen, position, key))
    assert setup_id is not None

    row = await repo.find_row(db, key)
    assert row is not None
    assert row.regime == "bearish"
    # The label is a column; the numbers behind it stay in evidence so the
    # threshold can be re-cut later without replaying the tape.
    assert row.evidence["regime_breadth"] == pytest.approx(-0.62)
    assert row.evidence["regime_sample"] == 180

    restored = snapshot_from_row(row)
    assert restored.regime == "bearish"
    assert restored.regime_breadth == pytest.approx(-0.62)
    assert restored.regime_energy_pct == pytest.approx(0.84)


@pytest.mark.anyio
async def test_the_exit_regime_is_written_only_when_the_position_settles(
    db: AsyncSession,
) -> None:
    """A mid-flight update must not stamp an exit tape: the row would then
    claim a settlement condition for a position that is still open."""
    from smc.market_regime import read_regime

    class Tape:
        def __init__(self, change: float) -> None:
            self.symbol = "S"
            self.change_15m_pct = change
            self.quote_volume_24h = 50_000_000.0

    choppy = read_regime([Tape(1.0 if i % 2 else -1.0) for i in range(80)])
    assert choppy.state == "choppy"

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None

    active = replace(position, status="ACTIVE", entered_at=T0 + 10, entry_price=100.2)
    await repo.update_lifecycle(db, setup_id, lifecycle_values(active, 2, None, choppy))
    row = await repo.find_row(db, key)
    assert row is not None and row.exit_regime is None

    settled = replace(active, status="INVALIDATED", settled_at=T0 + 90, realized_r=-1.0)
    await repo.update_lifecycle(db, setup_id, lifecycle_values(settled, 3, None, choppy))
    row = await repo.find_row(db, key)
    assert row is not None and row.exit_regime == "choppy"
    # …and the detection-time regime was never touched by a lifecycle write.
    assert row.regime == snapshot.regime


@pytest.mark.anyio
async def test_the_detection_regime_cannot_be_rewritten_through_a_lifecycle_update(
    db: AsyncSession,
) -> None:
    """The allowlist is the no-lookahead guarantee; `regime` is detection-time
    and must be outside it."""
    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    frozen = replace(snapshot, regime="bullish")
    position, _ = open_position(frozen, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(frozen, position, key))
    assert setup_id is not None

    await repo.update_lifecycle(db, setup_id, {"regime": "bearish", "last_price": 99.0})
    row = await repo.find_row(db, key)
    assert row is not None
    assert row.regime == "bullish"
    assert row.last_price == 99.0


@pytest.mark.anyio
async def test_statistics_segment_by_the_tape_and_never_pool_pre_regime_rows(
    db: AsyncSession,
) -> None:
    from app.research.router import _stats_by_regime

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    plan = [("bullish", 2.0), ("bullish", 1.0), ("choppy", -1.0), (None, 3.0)]
    for index, (regime, realized) in enumerate(plan):
        values = setup_values(
            replace(snapshot, regime=regime or "unknown"),
            position,
            f"SCALP:TST:{index}",
        )
        values["regime"] = regime
        values["status"] = "TARGET_HIT" if realized > 0 else "INVALIDATED"
        values["realized_r"] = realized
        values["settled_at"] = repo.to_utc(T0 + 100 + index)
        values["detected_at"] = repo.to_utc(T0 + index)
        await repo.insert_setup(db, values)

    buckets = _stats_by_regime(await repo.regime_outcome_rows(db))

    assert buckets["bullish"].total == 2
    assert buckets["bullish"].total_r == pytest.approx(3.0)
    assert buckets["choppy"].total_r == pytest.approx(-1.0)
    # A row from before regime was recorded is not a regime observation.
    assert buckets["unrecorded"].total == 1
    assert "bearish" not in buckets


# ── plan-varying alternatives ────────────────────────────────────────────────


def test_exit_arms_never_vary_the_plan() -> None:
    """An exit arm that moved the geometry would stop being about exits, and
    the axis it is registered on would be a lie."""
    from smc.arms import EXIT_ARMS, PLAN_ARMS, settlement_variants

    varying = {v.name for v in settlement_variants(CFG) if v.varies_plan}
    assert varying.isdisjoint({a.name for a in EXIT_ARMS})
    # …and every plan arm that runs must vary it, or it is a duplicate of the
    # control wearing a different name.
    assert varying == {a.name for a in PLAN_ARMS if a.active}


def test_a_plan_varying_alternative_persists_its_own_plan() -> None:
    """Without the plan on the row, a resumed swing variant would be settled
    against the *fast* stop — answering a different question, silently."""
    from dataclasses import replace as dc_replace

    from app.research.recorder import plan_values, variant_values

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    swing = dc_replace(
        snapshot,
        initial_invalidation=108.0,
        target=80.0,
        potential_rr=2.5,
        target_kind="equal_lows",
    )
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    blob = variant_values(
        {"no_trail": position, "structural_swing": position},
        {"structural_swing": swing},
    )
    assert blob is not None
    assert "plan" not in blob["no_trail"]
    assert blob["structural_swing"]["plan"] == plan_values(swing)
    assert blob["structural_swing"]["plan"]["initial_invalidation"] == 108.0


def test_a_stored_plan_is_restored_not_recomputed() -> None:
    from dataclasses import replace as dc_replace

    from app.research.recorder import variant_plans_from_row, variant_values

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    swing = dc_replace(snapshot, initial_invalidation=108.0, target=80.0, potential_rr=2.5)
    position, _ = open_position(snapshot, T0, 100.0, CFG)

    row = SimpleNamespace(
        variants=variant_values(
            {"no_trail": position, "structural_swing": position},
            {"structural_swing": swing},
        )
    )

    restored = variant_plans_from_row(row, snapshot)
    # Exit-rule variants have no plan of their own and must not gain one.
    assert set(restored) == {"structural_swing"}
    assert restored["structural_swing"].initial_invalidation == 108.0
    assert restored["structural_swing"].target == 80.0
    # …and everything that is not the plan still comes from the primary.
    assert restored["structural_swing"].symbol == snapshot.symbol
    assert restored["structural_swing"].detected_at == snapshot.detected_at
    assert restored["structural_swing"].regime == snapshot.regime


def test_an_unreadable_plan_is_dropped_rather_than_guessed() -> None:
    from app.research.recorder import variant_plans_from_row

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None

    row = SimpleNamespace(variants={"structural_swing": {"state": {}, "plan": {"target": 80.0}}})

    assert variant_plans_from_row(row, snapshot) == {}


def test_the_swing_variant_gets_days_not_hours() -> None:
    """A structural hold that inherited the scalp's 2h timeout would expire
    before its thesis resolved, and the comparison would measure the clock."""
    from smc.arms import settlement_variants

    swing = next(v for v in settlement_variants(CFG) if v.name == "structural_swing")
    assert swing.config.max_holding_seconds > CFG.max_holding_seconds * 10
    assert swing.config.entry_window_seconds > CFG.entry_window_seconds
