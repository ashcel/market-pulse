"""MARKET REGIME — the whole-tape read recorded alongside every forward test.

This module exists because two forward-test cohorts were compared and the gap
between them was tape, not detector: one ran through a trending afternoon where
the trailing rule kept 64% of its best excursion, the next through overnight
chop where the same rule kept 36% of a larger one. What is pinned here:

* it is a headcount, not a model — breadth over a liquidity floor plus the
  median absolute move, and nothing with memory or smoothing;
* illiquid and cold-start symbols do not vote;
* too few voters reads `unknown`, never a regime called off a handful of names;
* bullish and bearish are exact mirrors;
* a two-sided tape is `choppy` however violently it is moving, and `energy_pct`
  is what separates violent chop from a dead range;
* payloads round-trip, and anything unrecognised degrades to `unknown` rather
  than to a regime claim.
"""

from __future__ import annotations

from dataclasses import dataclass

from smc.market_regime import (
    MARKET_REGIME_VERSION,
    MIN_SAMPLE,
    UNKNOWN_REGIME,
    read_regime,
    regime_from_payload,
    regime_payload,
)


@dataclass
class FakeMetrics:
    """Only the fields `read_regime` touches — it is duck-typed on purpose so
    the engine never imports the app's window metrics."""

    symbol: str
    change_15m_pct: float | None = 0.0
    quote_volume_24h: float = 50_000_000.0


def tape(moves: list[float], **overrides: object) -> list[FakeMetrics]:
    return [
        FakeMetrics(symbol=f"S{index}", change_15m_pct=move, **overrides)  # type: ignore[arg-type]
        for index, move in enumerate(moves)
    ]


# ── the label ────────────────────────────────────────────────────────────────


def test_a_broadly_advancing_tape_is_bullish() -> None:
    regime = read_regime(tape([1.0] * 60 + [-1.0] * 10))
    assert regime.state == "bullish"
    assert regime.advancing > regime.declining
    assert regime.is_directional is True


def test_a_broadly_declining_tape_is_bearish() -> None:
    """Exact mirror of the bullish case — same shape, sign flipped."""
    regime = read_regime(tape([-1.0] * 60 + [1.0] * 10))
    assert regime.state == "bearish"
    assert regime.declining > regime.advancing
    assert regime.is_directional is True


def test_bullish_and_bearish_are_mirrors() -> None:
    up = read_regime(tape([1.5] * 50 + [-0.4] * 30))
    down = read_regime(tape([-1.5] * 50 + [0.4] * 30))
    assert up.advancing == down.declining
    assert up.declining == down.advancing
    assert up.breadth == -down.breadth
    assert up.energy_pct == down.energy_pct


def test_an_evenly_split_tape_is_choppy() -> None:
    regime = read_regime(tape([1.0, -1.0] * 40))
    assert regime.state == "choppy"
    assert regime.is_directional is False


def test_a_violent_two_sided_tape_is_still_choppy_but_carries_its_energy() -> None:
    """The label cannot separate a dead range from a violent chop, and should
    not try — the number is what does that."""
    quiet = read_regime(tape([0.02, -0.02] * 40))
    violent = read_regime(tape([4.0, -4.0] * 40))
    assert quiet.state == violent.state == "choppy"
    assert violent.energy_pct > quiet.energy_pct
    assert quiet.energy_pct < 0.1


def test_a_directional_majority_below_the_margin_is_not_called() -> None:
    """55/45 is not a trend. The margin is what stops a coin flip reading as
    a tailwind."""
    regime = read_regime(tape([1.0] * 55 + [-1.0] * 45))
    assert regime.state == "choppy"


def test_moves_inside_the_threshold_do_not_vote_either_way() -> None:
    regime = read_regime(tape([0.05] * 80))
    assert regime.advancing == 0.0
    assert regime.declining == 0.0
    assert regime.state == "choppy"


# ── who votes ────────────────────────────────────────────────────────────────


def test_illiquid_symbols_do_not_vote() -> None:
    liquid = tape([1.0] * 50)
    dust = tape([-1.0] * 200, quote_volume_24h=1_000.0)
    regime = read_regime(liquid + dust)
    assert regime.sample == 50
    assert regime.universe == 250
    assert regime.state == "bullish"


def test_a_symbol_without_the_window_does_not_vote() -> None:
    """Cold start: the window is `None`, and a missing read is not a flat one."""
    warm = tape([1.0] * 50)
    cold = tape([None] * 100)  # type: ignore[list-item]
    regime = read_regime(warm + cold)
    assert regime.sample == 50
    assert regime.state == "bullish"


def test_too_few_voters_reads_unknown() -> None:
    regime = read_regime(tape([1.0] * (MIN_SAMPLE - 1)))
    assert regime.state == "unknown"
    assert regime.is_directional is False
    assert regime.sample == MIN_SAMPLE - 1


def test_an_empty_tape_reads_unknown_rather_than_choppy() -> None:
    regime = read_regime([])
    assert regime.state == "unknown"
    assert regime.sample == 0
    assert regime.universe == 0


def test_the_universe_counts_every_symbol_seen_not_just_the_voters() -> None:
    regime = read_regime(tape([1.0] * 50) + tape([1.0] * 10, quote_volume_24h=0.0))
    assert regime.universe == 60
    assert regime.sample == 50


# ── the record ───────────────────────────────────────────────────────────────


def test_a_payload_round_trips() -> None:
    original = read_regime(tape([1.0] * 60 + [-1.0] * 10))
    restored = regime_from_payload(regime_payload(original))
    assert restored == original


def test_a_missing_read_stores_as_unknown_rather_than_as_an_absent_key() -> None:
    payload = regime_payload(None)
    assert payload["state"] == "unknown"
    assert payload["sample"] == 0
    assert payload["version"] == MARKET_REGIME_VERSION


def test_a_corrupt_payload_degrades_to_unknown_not_to_a_regime_claim() -> None:
    assert regime_from_payload(None) == UNKNOWN_REGIME
    assert regime_from_payload({"state": "moon"}) == UNKNOWN_REGIME
    assert regime_from_payload(["bullish"]) == UNKNOWN_REGIME  # type: ignore[arg-type]


def test_breadth_spans_minus_one_to_one() -> None:
    assert read_regime(tape([1.0] * 60)).breadth == 1.0
    assert read_regime(tape([-1.0] * 60)).breadth == -1.0
    assert read_regime(tape([0.0] * 60)).breadth == 0.0
