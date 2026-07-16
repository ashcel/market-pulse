"""Port of poi.test.ts."""

from typing import NamedTuple

import pytest

from smc.analysis import compute_pivots
from smc.equilibrium import DealingRange, compute_dealing_range
from smc.liquidity import compute_liquidity_pools
from smc.mock_candles import generate_mock_candles
from smc.objectives import Direction, ObjectiveCandidate, resolve_objectives
from smc.poi import build_anticipatory_plan, select_poi
from smc.structure import SwingPoint, compute_market_structure
from smc.types import PivotKind
from smc.zones import BaseZone, ZoneFreshness, ZoneKind, compute_base_zones
from tests.dreimann import DREIMANN_TRADES, label_time, load_dreimann_fixture


def zone(
    kind: ZoneKind,
    price_low: float,
    price_high: float,
    freshness: ZoneFreshness = "fresh",
    start_time: int = 1,
) -> BaseZone:
    return BaseZone(
        kind=kind,
        price_low=price_low,
        price_high=price_high,
        start_time=start_time,
        end_time=start_time + 1,
        freshness=freshness,
    )


def _swing(kind: PivotKind, price: float) -> SwingPoint:
    return SwingPoint(kind=kind, price=price, time=1, label=None, event=None, equal=None)


def range_at(low: float, high: float) -> DealingRange:
    """A range whose equilibrium is the midpoint of [low, high] — swings are stubs."""
    return DealingRange(
        low=_swing("low", low),
        high=_swing("high", high),
        anchor="low",
        equilibrium=(low + high) / 2,
    )


def objective_at(price: float, direction: Direction = "long") -> ObjectiveCandidate:
    return ObjectiveCandidate(
        direction=direction,
        swing=SwingPoint(
            kind="high" if direction == "long" else "low",
            price=price,
            time=9,
            label=None,
            event=None,
            equal=None,
        ),
        strength="weak",
        price=price,
        pool=None,
    )


RANGE = range_at(100, 200)  # equilibrium 150


class TestSelectPoi:
    def test_prefers_a_discount_side_demand_zone_over_a_nearer_premium_one(self) -> None:
        premium = zone("demand", 155, 160, "fresh")
        discount = zone("demand", 110, 120, "fresh")
        assert select_poi([premium, discount], "long", 170, RANGE) is discount

    def test_prefers_fresh_over_tested_then_the_nearest_proximal_edge(self) -> None:
        tested = zone("demand", 130, 140, "tested")
        fresh = zone("demand", 110, 120, "fresh")
        assert select_poi([tested, fresh], "long", 170, RANGE) is fresh

        near = zone("demand", 125, 135, "fresh")
        far = zone("demand", 105, 115, "fresh")
        assert select_poi([near, far], "long", 170, RANGE) is near

    def test_only_considers_zones_the_pullback_can_reach(self) -> None:
        above = zone("demand", 172, 180, "fresh")
        assert select_poi([above], "long", 170, RANGE) is None
        at = zone("demand", 160, 170, "fresh")
        assert select_poi([at], "long", 170, RANGE) is at

    def test_mirrors_for_shorts(self) -> None:
        discount = zone("supply", 140, 145, "fresh")
        premium = zone("supply", 180, 190, "fresh")
        assert select_poi([discount, premium], "short", 130, RANGE) is premium
        assert select_poi([zone("demand", 180, 190, "fresh")], "short", 130, RANGE) is None

    def test_skips_the_position_filter_when_no_dealing_range_exists(self) -> None:
        near = zone("demand", 155, 160, "fresh")
        far = zone("demand", 110, 120, "fresh")
        assert select_poi([near, far], "long", 170, None) is near


class TestBuildAnticipatoryPlan:
    DEMAND = zone("demand", 110, 120, "fresh")

    def test_derives_entry_stop_and_rr_from_the_limit_price(self) -> None:
        plan = build_anticipatory_plan([self.DEMAND], "long", 170, RANGE, [objective_at(180)])
        assert plan is not None
        assert plan.entry == 120
        assert plan.stop == 110
        assert plan.risk_per_unit == 10
        # Reward measured from the limit (120), not from_price (170).
        assert plan.reward_per_unit == 60
        assert plan.reward_risk == 6
        assert plan.objective.price == 180
        assert plan.entry_position == "discount"

    def test_mirrors_for_shorts(self) -> None:
        supply = zone("supply", 180, 190, "fresh")
        plan = build_anticipatory_plan([supply], "short", 130, RANGE, [objective_at(120, "short")])
        assert plan is not None
        assert plan.entry == 180
        assert plan.stop == 190
        assert plan.reward_per_unit == 60
        assert plan.entry_position == "premium"

    def test_targets_the_preferred_candidate_not_a_deeper_one(self) -> None:
        plan = build_anticipatory_plan(
            [self.DEMAND], "long", 170, RANGE, [objective_at(180), objective_at(195)]
        )
        assert plan is not None
        assert plan.objective.price == 180

    def test_returns_none_with_no_objective(self) -> None:
        assert build_anticipatory_plan([self.DEMAND], "long", 170, RANGE, []) is None

    def test_returns_none_with_no_qualifying_zone(self) -> None:
        assert build_anticipatory_plan([], "long", 170, RANGE, [objective_at(180)]) is None

    def test_returns_none_on_degenerate_geometry(self) -> None:
        assert (
            build_anticipatory_plan([self.DEMAND], "long", 170, RANGE, [objective_at(120)]) is None
        )
        assert (
            build_anticipatory_plan([self.DEMAND], "long", 170, RANGE, [objective_at(115)]) is None
        )

    def test_records_entry_position_none_when_no_range_exists(self) -> None:
        plan = build_anticipatory_plan([self.DEMAND], "long", 170, None, [objective_at(180)])
        assert plan is not None
        assert plan.entry_position is None

    def test_is_deterministic_and_replay_safe_over_prefix_windows(self) -> None:
        for symbol in ("BTC", "ETH"):
            candles = generate_mock_candles(symbol, "4H", 360)
            for n in range(60, len(candles) + 1, 30):
                window = candles[:n]
                structure = compute_market_structure(compute_pivots(window))
                pools = compute_liquidity_pools(structure)
                rng = compute_dealing_range(structure)
                zones = compute_base_zones(window)
                from_ = window[-1].close
                for direction in ("long", "short"):
                    objectives = resolve_objectives(structure, pools, direction, from_)
                    plan = build_anticipatory_plan(zones, direction, from_, rng, objectives)
                    assert build_anticipatory_plan(zones, direction, from_, rng, objectives) == plan
                    if plan is not None:
                        assert plan.zone.end_time <= window[-1].time
                        assert plan.objective.swing.time <= window[-1].time
                        assert plan.reward_risk > 0
                        ordered = (
                            plan.stop < plan.entry < plan.objective.price
                            if direction == "long"
                            else plan.objective.price < plan.entry < plan.stop
                        )
                        assert ordered


class EntryContext(NamedTuple):
    entry_price: float
    zones: list[BaseZone]
    range_: DealingRange | None
    objectives: list[ObjectiveCandidate]


def context_at_entry(name: str) -> EntryContext:
    fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
    entry_time = label_time(fixture.labels.entry.approx_time_utc)
    context = [c for c in fixture.series["4h"] if c.time <= entry_time]
    structure = compute_market_structure(compute_pivots(context))
    pools = compute_liquidity_pools(structure)
    entry_price = fixture.labels.entry.price
    return EntryContext(
        entry_price=entry_price,
        zones=compute_base_zones(context),
        range_=compute_dealing_range(structure),
        objectives=resolve_objectives(structure, pools, "long", entry_price),
    )


class TestDreimannAnnotationFidelityPoiStop:
    # Logic correctness only (R5). Zones are built on the 4h context candles.

    def test_zec_sl_derived_stop_sits_at_or_below_the_traders_swept_stop(self) -> None:
        # The instructive loss: his stop sat inside the POI's liquidity noise
        # and was wicked out before the objective printed.
        ctx = context_at_entry("zec-sl")
        plan = build_anticipatory_plan(
            ctx.zones, "long", ctx.entry_price, ctx.range_, ctx.objectives
        )
        assert plan is not None
        assert plan.stop <= 454.73
        assert plan.stop < plan.entry

    @pytest.mark.parametrize("name", DREIMANN_TRADES)
    def test_when_a_qualifying_4h_zone_exists_the_plan_is_coherent(self, name: str) -> None:
        ctx = context_at_entry(name)
        entry_price = ctx.entry_price
        plan = build_anticipatory_plan(ctx.zones, "long", entry_price, ctx.range_, ctx.objectives)
        if plan is None:
            # Finding, not failure: no qualifying demand zone (or no objective)
            # in the captured 4h window as-of entry.
            assert (
                len([z for z in ctx.zones if z.kind == "demand" and z.price_high <= entry_price])
                == 0
                or len(ctx.objectives) == 0
            )
            return
        assert plan.entry <= entry_price
        assert plan.stop == plan.zone.price_low
        assert plan.entry == plan.zone.price_high
        assert plan.objective.price > plan.entry
        assert plan.reward_risk > 0
