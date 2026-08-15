"""The instrument report: descriptive only, and honest about what it lacks.

The failure this suite is written against is not a wrong number — it is a
report that reads as a finding. So most of what is asserted here is restraint:
a missing fact never becomes a zero, a near-zero denominator never produces a
600% share, and nothing anywhere emits a verdict.
"""

from __future__ import annotations

import math

import pytest

from app.research.instrument_report import (
    LISTING_AGE_BUCKETS,
    MIN_N_FOR_A_CLAIM,
    STOP_NOISE_BUCKETS,
    bucketed,
    concentration,
    coverage,
    render,
    summarize,
)


def row(
    symbol: str = "TST",
    gross: float = 0.0,
    net: float | None = None,
    **evidence: object,
) -> dict[str, object]:
    return {
        "symbol": symbol,
        "gross_r": gross,
        "realized_r": net if net is not None else gross - 0.2,
        "cost_r": 0.2,
        "combo": "structure+activity",
        "tier": "HIGH",
        "mode": "SCALP",
        "direction": "bullish",
        "strategy_version": "discover-forward-test/1.2.0",
        "evidence": dict(evidence),
        "detected_at": None,
    }


# ── summarize ────────────────────────────────────────────────────────────────


def test_an_empty_bucket_summarizes_without_dividing_by_zero() -> None:
    cell = summarize("empty", [])
    assert cell.n == 0
    assert cell.gross_mean == 0.0
    assert cell.t == 0.0
    assert not cell.is_distinguishable


def test_a_single_observation_has_no_standard_error_and_no_claim() -> None:
    cell = summarize("one", [row(gross=3.0)])
    assert cell.n == 1
    assert cell.gross_se == 0.0
    # One observation must never read as a distinguishable result.
    assert not cell.is_distinguishable


def test_identical_observations_are_not_certainty() -> None:
    """Three stops that all resolved at exactly -1.000R have no spread yet.
    The interval collapses to a point, which must not read as a result."""
    cell = summarize("stops", [row(gross=-1.0) for _ in range(3)])
    assert cell.gross_se == 0.0
    assert not cell.is_distinguishable


def test_a_bucket_below_the_floor_is_never_marked() -> None:
    below = summarize("thin", [row(gross=g) for g in (2.0, 2.1, 1.9, 2.05)])
    assert below.n < MIN_N_FOR_A_CLAIM
    assert below.ci[0] > 0.0  # the arithmetic says separable
    assert not below.is_distinguishable  # the report still refuses to say so


def test_the_largest_symbol_is_measured_against_absolute_flow() -> None:
    """A bucket whose wins and losses cancel has a near-zero net sum. Dividing
    by it is how a report says '+600%' about an unremarkable book."""
    cell = summarize("cancelling", [row("A", 5.0), row("B", -4.9)])
    assert abs(cell.gross_sum) < 0.2
    assert cell.top_symbol == "A"
    assert 0.0 <= cell.top_symbol_share <= 1.0
    assert cell.top_symbol_r == pytest.approx(5.0)


def test_the_largest_symbol_can_be_the_losing_one() -> None:
    cell = summarize("mixed", [row("WIN", 1.0), row("LOSS", -6.0)])
    assert cell.top_symbol == "LOSS"
    assert cell.top_symbol_r == pytest.approx(-6.0)


def test_a_symbols_several_trades_are_added_before_ranking() -> None:
    cell = summarize(
        "repeat", [row("A", 2.0), row("A", 2.0), row("B", 3.0)]
    )
    assert cell.top_symbol == "A"
    assert cell.top_symbol_r == pytest.approx(4.0)


def test_distinguishable_means_the_interval_excludes_zero() -> None:
    tight = summarize(
        "tight", [row(gross=1.0 + (i % 3) * 0.1) for i in range(30)]
    )
    assert tight.is_distinguishable

    noisy = summarize(
        "noisy", [row(gross=g) for g in (5.0, -5.0, 4.0, -4.0, 3.0, -3.0)]
    )
    assert not noisy.is_distinguishable


# ── bucketing ────────────────────────────────────────────────────────────────


def test_a_missing_fact_lands_in_unknown_rather_than_the_first_bucket() -> None:
    cells = bucketed(
        [row(gross=1.0), row(gross=1.0, listing_age_days=3.0)],
        lambda r: (r["evidence"] or {}).get("listing_age_days"),  # type: ignore[union-attr]
        LISTING_AGE_BUCKETS,
    )
    labels = {c.label: c.n for c in cells}
    assert labels == {"<7d": 1, "unknown": 1}


def test_bucket_bounds_are_half_open_so_nothing_is_counted_twice() -> None:
    rows = [row(gross=1.0, listing_age_days=age) for age in (6.99, 7.0, 30.0, 365.0)]
    cells = bucketed(
        rows,
        lambda r: (r["evidence"] or {}).get("listing_age_days"),  # type: ignore[union-attr]
        LISTING_AGE_BUCKETS,
    )
    assert {c.label: c.n for c in cells} == {
        "<7d": 1,
        "7-30d": 1,
        "30-90d": 1,
        ">=365d": 1,
    }
    assert sum(c.n for c in cells) == len(rows)


def test_a_value_outside_every_bucket_is_unknown_not_dropped() -> None:
    cells = bucketed(
        [row(gross=1.0, stop_noise_ratio=-3.0)],
        lambda r: (r["evidence"] or {}).get("stop_noise_ratio"),  # type: ignore[union-attr]
        STOP_NOISE_BUCKETS,
    )
    assert {c.label: c.n for c in cells} == {"unknown": 1}


def test_an_infinite_bucket_edge_catches_the_tail() -> None:
    cells = bucketed(
        [row(gross=1.0, stop_noise_ratio=1e9)],
        lambda r: (r["evidence"] or {}).get("stop_noise_ratio"),  # type: ignore[union-attr]
        STOP_NOISE_BUCKETS,
    )
    assert {c.label for c in cells} == {">=4x"}


# ── coverage ─────────────────────────────────────────────────────────────────


def test_coverage_counts_only_rows_that_actually_carry_the_fact() -> None:
    rows = [
        row(gross=1.0, listing_age_days=10.0),
        row(gross=1.0),
        row(gross=1.0, listing_age_days=None),
    ]
    assert coverage(rows, "listing_age_days") == (1, 3)


def test_a_non_numeric_or_infinite_fact_does_not_count_as_coverage() -> None:
    rows = [
        row(gross=1.0, listing_age_days="soon"),
        row(gross=1.0, listing_age_days=math.inf),
        row(gross=1.0, listing_age_days=float("nan")),
    ]
    assert coverage(rows, "listing_age_days") == (0, 3)


# ── concentration ────────────────────────────────────────────────────────────


def test_concentration_finds_the_symbols_carrying_the_book() -> None:
    rows = [row(f"S{i}", 0.01) for i in range(40)] + [row("WHALE", 10.0)]
    conc = concentration(rows)

    assert conc.symbols == 41
    assert conc.symbols_for_half == 1
    assert conc.is_concentrated
    assert conc.ex_top5.n == 36


def test_a_flat_book_is_not_flagged_as_concentrated() -> None:
    conc = concentration([row(f"S{i}", 1.0) for i in range(50)])
    assert not conc.is_concentrated
    assert conc.symbols_for_half > 5


def test_one_vote_per_symbol_differs_from_one_vote_per_trade() -> None:
    """Twenty losing trades on one symbol should not outvote twenty symbols."""
    rows = [row("LOUD", -1.0) for _ in range(20)] + [row(f"S{i}", 1.0) for i in range(20)]
    conc = concentration(rows)

    per_trade = sum(float(r["gross_r"]) for r in rows) / len(rows)
    assert per_trade == pytest.approx(0.0)
    # 20 symbols at +1 and one at -1 — equal weight leans positive.
    assert conc.equal_weight_mean > 0.5
    assert conc.median_symbol_mean == pytest.approx(1.0)


def test_concentration_survives_a_book_that_nets_to_zero() -> None:
    conc = concentration([row("A", 5.0), row("B", -5.0)])
    assert conc.gross_sum == pytest.approx(0.0)
    assert conc.top5_share == 0.0  # undefined rather than infinite


# ── rendering ────────────────────────────────────────────────────────────────


def test_the_report_says_it_is_exploratory_and_names_no_verdict() -> None:
    document = render([row(gross=1.0) for _ in range(20)], "discover-forward-test/1.2.0")

    assert "Exploratory. No verdicts" in document
    for word in ("PASS", "RETIRE", "INSUFFICIENT"):
        assert word not in document


def test_a_cut_with_no_coverage_says_so_instead_of_showing_a_table() -> None:
    document = render([row(gross=1.0) for _ in range(20)], None)
    assert "coverage 0/20" in document
    assert "Not yet recorded on any settled row" in document


def test_a_covered_cut_renders_its_buckets() -> None:
    rows = [row(gross=1.0, listing_age_days=3.0) for _ in range(10)]
    rows += [row(gross=-1.0, listing_age_days=400.0) for _ in range(10)]
    document = render(rows, None)

    assert "coverage 20/20" in document
    assert "`<7d`" in document
    assert "`>=365d`" in document


def test_an_empty_record_renders_without_claiming_anything() -> None:
    document = render([], None)
    assert "No settled setups in scope" in document


def test_a_concentrated_book_carries_its_warning_into_the_document() -> None:
    rows = [row(f"S{i}", 0.01) for i in range(40)] + [row("WHALE", 10.0)]
    document = render(rows, None)
    assert "top five symbols carry most of this book" in document
