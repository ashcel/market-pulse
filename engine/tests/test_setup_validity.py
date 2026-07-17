"""Port of setup-validity.test.ts — the live-price freshness gate."""

import math
from dataclasses import replace

from smc.setup_validity import SetupValidityPlan, validate_setup_freshness

LONG_PLAN = SetupValidityPlan(
    direction="long", entry=100, entry_low=98, entry_high=101, stop=95, target1=110, target2=120
)

SHORT_PLAN = SetupValidityPlan(
    direction="short", entry=100, entry_low=99, entry_high=101, stop=105, target1=90, target2=80
)


class TestHappyPath:
    def test_valid_inside_entry_zone_long(self) -> None:
        result = validate_setup_freshness(LONG_PLAN, 100)
        assert result.valid is True
        assert result.severity == "valid"
        assert result.reason is None

    def test_valid_slightly_above_zone_with_positive_rr_long(self) -> None:
        # entry 100, stop 95, target1 110 — risk=4, reward=6 at 102 → R:R 1.5
        assert validate_setup_freshness(LONG_PLAN, 102).valid is True

    def test_valid_inside_entry_zone_short(self) -> None:
        result = validate_setup_freshness(SHORT_PLAN, 100)
        assert result.valid is True
        assert result.severity == "valid"


class TestInvalidated:
    def test_at_stop_long(self) -> None:
        r = validate_setup_freshness(LONG_PLAN, 95)
        assert r.valid is False
        assert r.severity == "invalidated"

    def test_below_stop_long(self) -> None:
        r = validate_setup_freshness(LONG_PLAN, 94)
        assert r.valid is False
        assert r.severity == "invalidated"

    def test_at_stop_short(self) -> None:
        r = validate_setup_freshness(SHORT_PLAN, 105)
        assert r.valid is False
        assert r.severity == "invalidated"

    def test_above_stop_short(self) -> None:
        r = validate_setup_freshness(SHORT_PLAN, 106)
        assert r.valid is False
        assert r.severity == "invalidated"


class TestPastTarget:
    def test_at_target1_long(self) -> None:
        r = validate_setup_freshness(LONG_PLAN, 110)
        assert r.valid is False
        assert r.severity == "stale"

    def test_past_target1_long(self) -> None:
        r = validate_setup_freshness(LONG_PLAN, 115)
        assert r.valid is False
        assert r.severity == "stale"

    def test_at_target1_short(self) -> None:
        r = validate_setup_freshness(SHORT_PLAN, 90)
        assert r.valid is False
        assert r.severity == "stale"

    def test_past_target1_short(self) -> None:
        r = validate_setup_freshness(SHORT_PLAN, 85)
        assert r.valid is False
        assert r.severity == "stale"


class TestNegativeRr:
    def test_wide_stop_near_target_stays_valid_long(self) -> None:
        # The negative R:R case only happens when price is past target1
        # (handled above) or at/below stop (invalidated) — this validates the
        # code path doesn't false-positive.
        plan = SetupValidityPlan(
            direction="long",
            entry=100,
            entry_low=99,
            entry_high=101,
            stop=80,
            target1=105,
            target2=110,
        )
        assert validate_setup_freshness(plan, 104).valid is True

    def test_short_near_stop_between_entry_and_target_stays_valid(self) -> None:
        assert validate_setup_freshness(SHORT_PLAN, 104).valid is True


class TestChasedPastEntryZone:
    def test_far_above_entry_zone_long(self) -> None:
        # riskPerUnit = 5, staleDistance = 10, threshold = 101 + 10 = 111.
        plan = SetupValidityPlan(
            direction="long",
            entry=100,
            entry_low=98,
            entry_high=101,
            stop=95,
            target1=130,
            target2=150,
        )
        r = validate_setup_freshness(plan, 112)
        assert r.valid is False
        assert r.severity == "stale"
        assert r.reason is not None and "past the entry zone" in r.reason

    def test_far_below_entry_zone_short(self) -> None:
        # riskPerUnit = 5, staleDistance = 10, threshold = 99 - 10 = 89.
        plan = SetupValidityPlan(
            direction="short",
            entry=100,
            entry_low=99,
            entry_high=101,
            stop=105,
            target1=70,
            target2=50,
        )
        r = validate_setup_freshness(plan, 88)
        assert r.valid is False
        assert r.severity == "stale"
        assert r.reason is not None and "past the entry zone" in r.reason


class TestBadData:
    def test_nan_live_price(self) -> None:
        r = validate_setup_freshness(LONG_PLAN, math.nan)
        assert r.valid is True and r.severity == "valid"

    def test_zero_live_price(self) -> None:
        r = validate_setup_freshness(LONG_PLAN, 0)
        assert r.valid is True and r.severity == "valid"

    def test_infinite_live_price(self) -> None:
        r = validate_setup_freshness(LONG_PLAN, math.inf)
        assert r.valid is True and r.severity == "valid"

    def test_nan_stop(self) -> None:
        r = validate_setup_freshness(replace(LONG_PLAN, stop=math.nan), 100)
        assert r.valid is True and r.severity == "valid"

    def test_infinite_entry(self) -> None:
        r = validate_setup_freshness(replace(LONG_PLAN, entry=math.inf), 100)
        assert r.valid is True and r.severity == "valid"

    def test_zero_risk_degenerate_plan(self) -> None:
        r = validate_setup_freshness(replace(LONG_PLAN, entry=100, stop=100), 100)
        assert r.valid is True and r.severity == "valid"


class TestBoundaries:
    def test_just_inside_and_outside_stale_distance_long(self) -> None:
        plan = SetupValidityPlan(
            direction="long",
            entry=100,
            entry_low=98,
            entry_high=101,
            stop=95,
            target1=130,
            target2=150,
        )
        # threshold = 101 + 10 = 111.
        assert validate_setup_freshness(plan, 110.99).valid is True
        assert validate_setup_freshness(plan, 111.01).valid is False

    def test_just_above_stop_long(self) -> None:
        assert validate_setup_freshness(LONG_PLAN, 95.01).valid is True


class TestRealWorldScenarios:
    def test_uni_long_chased(self) -> None:
        # riskPerUnit = 0.026, staleDistance = 0.052, threshold = 3.192.
        uni_plan = SetupValidityPlan(
            direction="long",
            entry=3.124,
            entry_low=3.098,
            entry_high=3.14,
            stop=3.098,
            target1=3.696,
            target2=4.5,
        )
        r = validate_setup_freshness(uni_plan, 3.487)
        assert r.valid is False
        assert r.severity == "stale"

    def test_near_short_past_entry_zone(self) -> None:
        # riskPerUnit = 0.013, staleDistance = 0.026, threshold = 1.893.
        near_plan = SetupValidityPlan(
            direction="short",
            entry=1.919,
            entry_low=1.919,
            entry_high=1.932,
            stop=1.932,
            target1=1.858,
            target2=1.8,
        )
        r = validate_setup_freshness(near_plan, 1.893)
        assert r.valid is False
        assert r.severity == "stale"

    def test_aave_long_at_zone_valid(self) -> None:
        aave_plan = SetupValidityPlan(
            direction="long",
            entry=91.31,
            entry_low=90.84,
            entry_high=91.31,
            stop=90.84,
            target1=97.41,
            target2=105,
        )
        assert validate_setup_freshness(aave_plan, 91.5).valid is True
