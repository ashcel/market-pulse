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

import pytest
from httpx import ASGITransport, AsyncClient
from smc.context_alignment import Alignment
from smc.forward_test import DEFAULT_FORWARD_TEST_CONFIG, open_position
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
    response = await api.get(
        "/api/v1/research/forward-test/00000000-0000-0000-0000-000000000000"
    )
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
    from smc.forward_test import advance_position, default_variants

    snapshot = snapshot_from(situation(), T0, CFG)
    assert snapshot is not None
    position, _ = open_position(snapshot, T0, 100.0, CFG)
    key = setup_key(situation())
    setup_id = await repo.insert_setup(db, setup_values(snapshot, position, key))
    assert setup_id is not None

    # Fill, then run to target on every rule.
    alternatives = {
        variant.name: open_position(snapshot, T0, 100.0, variant.config)[0]
        for variant in default_variants(CFG)
    }
    # 100.3 is inside the entry zone (100.0-100.385); 100.4 would miss it.
    for offset, price in ((30, 100.3), (120, 93.0)):
        position, _ = advance_position(snapshot, position, price, T0 + offset, CFG)
        for name, alt in list(alternatives.items()):
            alternatives[name], _ = advance_position(
                snapshot, alt, price, T0 + offset, CFG
            )
    assert position.status == "TARGET_HIT"

    await repo.update_lifecycle(db, setup_id, lifecycle_values(position, 4, alternatives))
    row = await db.get(ForwardTestSetup, setup_id)
    assert row is not None
    assert row.variants is not None
    assert set(row.variants) == {"no_trail", "wide_trail"}
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


def test_the_generation_moved_for_the_cost_change() -> None:
    """Costs change what a recorded result means, so generation-2 rows must
    never be averaged with generation-3 ones."""
    from app.research.recorder import DETECTOR_GENERATION

    assert DETECTOR_GENERATION == 3
