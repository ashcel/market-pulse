"""The archive's job is to stop two cohorts being averaged when they must not
be, and to stop 215 rows being thrown away when they may be. Both failures are
silent, so both are tested here."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from datetime import date

import pytest

from smc.forward_test import FORWARD_TEST_VERSION
from smc.version_archive import (
    ARCHIVE,
    LIVE,
    METRICS,
    Release,
    pooled_generations,
    pooled_with_live,
    release_for,
    releases_for_version,
)


class TestArchiveShape:
    def test_it_describes_the_version_being_written(self) -> None:
        """The import guard's condition, asserted where a failure is readable.

        An archive describing a version other than the live one would answer
        pooling questions confidently and wrongly.
        """
        assert LIVE.forward_test_version == FORWARD_TEST_VERSION

    def test_generations_are_contiguous_from_one(self) -> None:
        assert [r.generation for r in ARCHIVE] == list(range(1, len(ARCHIVE) + 1))

    def test_the_first_release_pools_with_nothing(self) -> None:
        first = ARCHIVE[0]
        assert not first.gross_comparable
        assert not first.net_comparable
        assert not first.population_comparable

    def test_every_release_says_what_changed(self) -> None:
        for release in ARCHIVE:
            assert release.changed, f"generation {release.generation} lists no change"
            assert release.summary

    def test_strategy_version_matches_the_recorder_stamp(self) -> None:
        assert LIVE.strategy_version == f"discover-forward-test/{FORWARD_TEST_VERSION}"


class TestLookup:
    def test_a_version_can_hold_several_generations(self) -> None:
        """The reason the archive is keyed by generation and not by version:
        1.0.0 carries three different experiments."""
        assert [r.generation for r in releases_for_version("1.0.0")] == [1, 2, 3]

    def test_the_full_stamp_resolves_the_same_way(self) -> None:
        assert releases_for_version("discover-forward-test/1.0.0") == releases_for_version(
            "1.0.0"
        )

    def test_an_unknown_version_resolves_to_nothing(self) -> None:
        assert releases_for_version("9.9.9") == ()

    def test_an_unstamped_row_maps_to_no_release(self) -> None:
        """None is an absent stamp, not generation 1."""
        assert release_for(None) is None

    def test_an_unknown_generation_maps_to_no_release(self) -> None:
        assert release_for(99) is None


class TestPooling:
    def test_generation_six_pools_gross_with_five(self) -> None:
        """Its change was to how the round trip is priced. `gross_r` is
        untouched by that, and every arm gate is written against gross — so the
        arms lose no sample at the boundary."""
        assert pooled_generations(6, "gross_r") == (5, 6)

    def test_generation_six_does_not_pool_net_with_five(self) -> None:
        assert pooled_generations(6, "net_r") == (6,)

    def test_pooling_is_symmetric(self) -> None:
        """Asking from either side of a boundary gives the same set. A rule
        that depended on which cohort you started from would let the same two
        cohorts be both poolable and not."""
        for metric in METRICS:
            for release in ARCHIVE:
                for other in pooled_generations(release.generation, metric):
                    assert pooled_generations(other, metric) == pooled_generations(
                        release.generation, metric
                    )

    def test_a_cohort_always_pools_with_itself(self) -> None:
        for metric in METRICS:
            for release in ARCHIVE:
                assert release.generation in pooled_generations(release.generation, metric)

    def test_an_isolated_cohort_pools_alone(self) -> None:
        assert pooled_generations(4, "gross_r") == (4,)

    def test_an_unknown_cohort_pools_with_nothing_at_all(self) -> None:
        """Not even itself: there is no declared basis on which to average it."""
        assert pooled_generations(99, "gross_r") == ()

    def test_pooled_with_live_tracks_the_last_release(self) -> None:
        for metric in METRICS:
            assert pooled_with_live(metric) == pooled_generations(LIVE.generation, metric)

    def test_a_pool_is_a_contiguous_run(self) -> None:
        """Comparability is declared against the immediate predecessor, so a
        pool can never skip a generation — that would mean averaging across a
        break the archive itself recorded."""
        for metric in METRICS:
            for release in ARCHIVE:
                pool = pooled_generations(release.generation, metric)
                assert list(pool) == list(range(pool[0], pool[-1] + 1))


class TestComparableAccessor:
    @pytest.mark.parametrize(
        ("metric", "attribute"),
        [
            ("gross_r", "gross_comparable"),
            ("net_r", "net_comparable"),
            ("population", "population_comparable"),
        ],
    )
    def test_it_reads_the_matching_flag(self, metric: str, attribute: str) -> None:
        for release in ARCHIVE:
            assert release.comparable(metric) is getattr(release, attribute)  # type: ignore[arg-type]

    def test_a_release_is_frozen(self) -> None:
        """Rows recorded under a release still mean what they meant; editing one
        in place would rewrite history that is still on disk."""
        with pytest.raises(FrozenInstanceError):
            ARCHIVE[0].summary = "something else"  # type: ignore[misc]

    def test_release_is_constructible_for_a_future_cohort(self) -> None:
        """The archive is append-only, and appending must stay cheap."""
        release = Release(
            generation=99,
            forward_test_version="9.0.0",
            opened=date(2030, 1, 1),
            summary="hypothetical",
            changed=("nothing real",),
            gross_comparable=True,
            net_comparable=True,
            population_comparable=True,
        )
        assert release.strategy_version == "discover-forward-test/9.0.0"
        assert release.comparable("gross_r")
