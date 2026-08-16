"""The version report joins the declared archive to what the record holds.

The tests here are mostly about what it refuses to fold together: an unstamped
row into generation 1, a NO_FILL into a per-trade mean, or two cohorts into one
number for a metric the archive says broke between them.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from smc.version_archive import ARCHIVE, LIVE

from app.research.version_report import (
    Row,
    build_cohorts,
    build_pools,
)

NOW = datetime(2026, 8, 16, 12, 0, tzinfo=UTC)


def row(
    generation: int | None,
    *,
    status: str = "TARGET_HIT",
    entered: bool = True,
    settled: bool = True,
    gross: float = 1.0,
    net: float = 0.8,
    cost: float = 0.2,
    minutes: int = 0,
    version: str = "discover-forward-test/1.3.0",
) -> Row:
    return Row(
        generation=generation,
        strategy_version=version,
        status=status,
        detected_at=NOW + timedelta(minutes=minutes),
        entered=entered,
        settled=settled,
        gross_r=gross,
        realized_r=net,
        cost_r=cost,
    )


def cohort_for(cohorts: list, generation: int | None):
    return next(c for c in cohorts if c.generation == generation)


class TestCohorts:
    def test_every_declared_release_appears_even_with_no_rows(self) -> None:
        """A release that shipped and then wrote nothing is a fact worth
        seeing — it is how you notice a restart never happened."""
        cohorts = build_cohorts([])
        assert [c.generation for c in cohorts] == [r.generation for r in ARCHIVE]
        assert all(c.detected == 0 for c in cohorts)

    def test_an_unstamped_row_gets_its_own_bucket(self) -> None:
        """Not generation 1. A missing stamp is not a known value."""
        cohorts = build_cohorts([row(None), row(1)])
        assert cohort_for(cohorts, None).detected == 1
        assert cohort_for(cohorts, 1).detected == 1
        assert cohort_for(cohorts, None).release is None

    def test_the_unstamped_bucket_sorts_last(self) -> None:
        cohorts = build_cohorts([row(None), row(5)])
        assert cohorts[-1].generation is None

    def test_counts_separate_detected_filled_and_settled(self) -> None:
        rows = [
            row(5),
            row(5, entered=False, settled=True, status="NO_FILL"),
            row(5, entered=True, settled=False, status="ACTIVE"),
        ]
        cohort = cohort_for(build_cohorts(rows), 5)
        # The NO_FILL settled: price never arrived, which is a resolved outcome
        # of the plan. It is counted as settled and not as filled, which is
        # exactly the pair of facts a single "closed" count would lose.
        assert (cohort.detected, cohort.filled, cohort.settled) == (3, 2, 2)

    def test_an_unfilled_row_contributes_no_r(self) -> None:
        """A NO_FILL is a real outcome of the plan but has no per-trade R.
        Averaging its zero in would dilute the cohort by however often price
        never arrived."""
        rows = [row(5, gross=1.0), row(5, entered=False, status="NO_FILL", gross=0.0)]
        cohort = cohort_for(build_cohorts(rows), 5)
        assert cohort.settled == 2
        assert cohort.gross == [1.0]
        assert cohort.mean_gross == 1.0

    def test_an_unsettled_row_contributes_no_r(self) -> None:
        rows = [row(5, settled=False, status="ACTIVE", gross=9.0)]
        cohort = cohort_for(build_cohorts(rows), 5)
        assert cohort.gross == []
        assert cohort.mean_gross is None

    def test_first_and_last_seen_span_the_cohort(self) -> None:
        rows = [row(5, minutes=30), row(5, minutes=0), row(5, minutes=10)]
        cohort = cohort_for(build_cohorts(rows), 5)
        assert cohort.first_seen == NOW
        assert cohort.last_seen == NOW + timedelta(minutes=30)

    def test_it_records_every_version_stamp_it_saw(self) -> None:
        """One generation under two version strings means the stamp and the
        archive disagree — visible, not averaged away."""
        rows = [
            row(5, version="discover-forward-test/1.2.0"),
            row(5, version="discover-forward-test/1.2.1"),
        ]
        cohort = cohort_for(build_cohorts(rows), 5)
        assert cohort.versions == {
            "discover-forward-test/1.2.0",
            "discover-forward-test/1.2.1",
        }

    def test_an_undeclared_generation_still_gets_a_bucket(self) -> None:
        """A row from the future, or from a rolled-back deploy, is never
        dropped on the floor."""
        cohorts = build_cohorts([row(99)])
        assert cohort_for(cohorts, 99).release is None
        assert cohort_for(cohorts, 99).detected == 1

    def test_label_names_the_unstamped_bucket(self) -> None:
        cohorts = build_cohorts([row(None), row(5)])
        assert cohort_for(cohorts, None).label == "unstamped"
        assert cohort_for(cohorts, 5).label == "5"


class TestPools:
    def test_gross_pools_across_the_generation_six_boundary(self) -> None:
        rows = [row(5, gross=1.0), row(6, gross=3.0)]
        pools = {p.metric: p for p in build_pools(build_cohorts(rows))}
        assert pools["gross_r"].generations == (5, 6)
        assert pools["gross_r"].n == 2
        assert pools["gross_r"].mean == 2.0

    def test_net_does_not(self) -> None:
        """Generation 6 reprices the round trip, so `realized_r` restarts."""
        rows = [row(5, net=1.0), row(6, net=3.0)]
        pools = {p.metric: p for p in build_pools(build_cohorts(rows))}
        assert pools["net_r"].generations == (6,)
        assert pools["net_r"].n == 1
        assert pools["net_r"].mean == 3.0

    def test_a_pool_names_what_it_excludes(self) -> None:
        pools = {p.metric: p for p in build_pools(build_cohorts([]))}
        assert 4 in pools["gross_r"].excluded
        assert 5 in pools["net_r"].excluded

    def test_unstamped_rows_join_no_pool(self) -> None:
        rows = [row(None, gross=100.0), row(6, gross=1.0)]
        pools = {p.metric: p for p in build_pools(build_cohorts(rows))}
        assert pools["gross_r"].mean == 1.0
        assert pools["net_r"].n == 1

    def test_an_undeclared_generation_joins_no_pool(self) -> None:
        rows = [row(99, gross=100.0), row(6, gross=1.0)]
        pools = {p.metric: p for p in build_pools(build_cohorts(rows))}
        assert 99 not in pools["gross_r"].generations
        assert pools["gross_r"].mean == 1.0

    def test_population_counts_detections_not_settlements(self) -> None:
        """The population question is "which setups existed", so an open row
        counts and a per-trade R does not enter it."""
        rows = [row(6), row(6, settled=False, status="ACTIVE")]
        pools = {p.metric: p for p in build_pools(build_cohorts(rows))}
        assert pools["population"].n == 2

    def test_pools_are_reported_for_every_metric(self) -> None:
        pools = build_pools(build_cohorts([]))
        assert {p.metric for p in pools} == {"gross_r", "net_r", "population"}

    def test_an_empty_pool_reports_no_mean_rather_than_zero(self) -> None:
        pools = {p.metric: p for p in build_pools(build_cohorts([]))}
        assert pools["gross_r"].n == 0
        assert pools["gross_r"].mean is None

    def test_pools_are_anchored_on_the_live_cohort(self) -> None:
        pools = build_pools(build_cohorts([]))
        for pool in pools:
            assert LIVE.generation in pool.generations
