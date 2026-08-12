"""MOMENTUM RADAR detector + state machine.

The state machine is the contract these tests defend: a candidate may only
reach CONTINUATION through an actual continuation event, INVALID is terminal
and always names a reason, and bullish/bearish are exact mirrors of each other.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from smc.momentum import (
    DEFAULT_CONFIG,
    Candidate,
    MomentumConfig,
    WindowMetrics,
    advance_candidate,
    detect_momentum,
    expire_candidate,
    momentum_score,
    open_candidate,
    rank,
    retrace_fraction,
    should_drop,
)

T0 = 1_700_000_000.0


def metrics(**overrides: object) -> WindowMetrics:
    """A symbol mid-impulse: +2% over 3m on 4x volume and 3x trade rate."""
    base = dict(
        symbol="TST",
        ts=T0,
        price=110.0,
        change_1m_pct=1.0,
        change_3m_pct=2.0,
        change_5m_pct=2.5,
        change_15m_pct=3.0,
        rvol_1m=4.0,
        rvol_3m=4.0,
        rvol_5m=3.0,
        trade_rate_mult=3.0,
        range_expansion=2.0,
        window_high=110.0,
        window_low=100.0,
        quote_volume_1m=250_000.0,
        trades_1m=900.0,
        quote_volume_24h=18_500_000.0,
        change_24h_pct=12.0,
        last_meaningful_ts=T0,
        warming_up=False,
    )
    base.update(overrides)
    return WindowMetrics(**base)  # type: ignore[arg-type]


def mirrored(m: WindowMetrics) -> WindowMetrics:
    """The exact bearish reflection of a bullish read: every signed quantity
    negated, price levels reflected through 100."""
    return replace(
        m,
        change_1m_pct=None if m.change_1m_pct is None else -m.change_1m_pct,
        change_3m_pct=None if m.change_3m_pct is None else -m.change_3m_pct,
        change_5m_pct=None if m.change_5m_pct is None else -m.change_5m_pct,
        change_15m_pct=None if m.change_15m_pct is None else -m.change_15m_pct,
        change_24h_pct=-m.change_24h_pct,
        price=200.0 - m.price,
        window_high=200.0 - m.window_low,
        window_low=200.0 - m.window_high,
    )


def opened(m: WindowMetrics | None = None) -> Candidate:
    read = m if m is not None else metrics()
    signal = detect_momentum(read)
    assert signal is not None
    return open_candidate(read, signal)


# ── configuration ────────────────────────────────────────────────────────────


def test_score_weights_must_sum_to_one() -> None:
    with pytest.raises(ValueError, match="sum to 1.0"):
        MomentumConfig(weight_displacement=0.9)


# ── detection ────────────────────────────────────────────────────────────────


def test_detects_bullish_momentum() -> None:
    signal = detect_momentum(metrics())
    assert signal is not None
    assert signal.direction == "bullish"
    assert 0.0 < signal.score <= 100.0
    assert all(signal.gates.values())


def test_detects_bearish_momentum() -> None:
    signal = detect_momentum(mirrored(metrics()))
    assert signal is not None
    assert signal.direction == "bearish"


def test_no_detection_while_warming_up() -> None:
    assert detect_momentum(metrics(warming_up=True)) is None
    assert detect_momentum(metrics(change_3m_pct=None)) is None


def test_displacement_without_volume_is_not_a_candidate() -> None:
    """The spec case: a big move on flat participation is not interesting."""
    assert detect_momentum(metrics(change_3m_pct=5.0, rvol_1m=1.0, rvol_3m=1.0)) is None


def test_volume_without_displacement_is_not_a_candidate() -> None:
    assert detect_momentum(metrics(change_1m_pct=0.05, change_3m_pct=0.1)) is None


def test_trade_rate_gate_is_required() -> None:
    assert detect_momentum(metrics(trade_rate_mult=1.0)) is None
    assert detect_momentum(metrics(trade_rate_mult=None)) is None


def test_whipsaw_is_rejected_by_alignment_gate() -> None:
    """A 1m spike against the 3m move is a fade, not fresh momentum."""
    assert detect_momentum(metrics(change_1m_pct=-1.2, change_3m_pct=2.0)) is None
    loose = replace(DEFAULT_CONFIG, require_aligned_1m_3m=False)
    assert detect_momentum(metrics(change_1m_pct=-1.2, change_3m_pct=2.0), loose) is not None


# ── scoring ──────────────────────────────────────────────────────────────────


def test_relative_volume_expansion_raises_the_score() -> None:
    weak, _ = momentum_score(metrics(rvol_1m=1.2, rvol_3m=1.2), "bullish")
    strong, _ = momentum_score(metrics(rvol_1m=5.0, rvol_3m=5.0), "bullish")
    assert strong > weak


def test_score_is_monotonic_in_each_component() -> None:
    # Start below every saturation point so each lever has room to move.
    mild = dict(
        change_1m_pct=0.3,
        change_3m_pct=0.9,
        change_5m_pct=1.2,
        rvol_1m=2.0,
        rvol_3m=2.0,
        trade_rate_mult=2.0,
        range_expansion=1.5,
    )
    baseline, _ = momentum_score(metrics(**mild), "bullish")
    for field_name, bigger in (
        ("change_3m_pct", 1.8),
        ("rvol_3m", 4.0),
        ("trade_rate_mult", 4.5),
        ("range_expansion", 3.5),
    ):
        raised, _ = momentum_score(metrics(**{**mild, field_name: bigger}), "bullish")
        assert raised > baseline, field_name


def test_small_move_on_heavy_volume_beats_large_move_on_thin_volume() -> None:
    """+2% on 5x volume must outrank +5% on ~1x volume."""
    heavy, _ = momentum_score(
        metrics(change_1m_pct=0.9, change_3m_pct=2.0, rvol_1m=5.0, rvol_3m=5.0, trade_rate_mult=4.0),
        "bullish",
    )
    thin, _ = momentum_score(
        metrics(change_1m_pct=1.6, change_3m_pct=5.0, rvol_1m=1.1, rvol_3m=1.1, trade_rate_mult=1.1),
        "bullish",
    )
    assert heavy > thin


def test_fresh_small_move_outranks_stale_large_move() -> None:
    """The §8 case: +10% twenty minutes ago and now dead ranks below a +2% that
    just started with expanding volume."""
    fresh, _ = momentum_score(
        metrics(change_1m_pct=0.8, change_3m_pct=2.0, change_5m_pct=2.1, rvol_1m=5.0, rvol_3m=5.0),
        "bullish",
    )
    stale, _ = momentum_score(
        metrics(
            change_1m_pct=0.02,
            change_3m_pct=0.05,
            change_5m_pct=10.0,
            rvol_1m=1.0,
            rvol_3m=1.0,
            trade_rate_mult=1.0,
            range_expansion=1.0,
        ),
        "bullish",
    )
    assert fresh > stale


def test_missing_windows_score_zero_not_crash() -> None:
    score, components = momentum_score(
        WindowMetrics(symbol="TST", ts=T0, price=1.0), "bullish"
    )
    assert score == 0.0
    assert set(components) == {
        "displacement",
        "rvol",
        "trade_rate",
        "range_expansion",
        "freshness",
    }


# ── opening a candidate ──────────────────────────────────────────────────────


def test_open_anchors_the_impulse_leg_on_the_window_extremes() -> None:
    candidate = opened()
    assert candidate.state == "MOMENTUM"
    assert (candidate.impulse_origin, candidate.impulse_extreme) == (100.0, 110.0)
    assert candidate.pullback_extreme == 110.0
    assert candidate.history[0].to_state == "MOMENTUM"
    assert candidate.history[0].from_state == ""


def test_open_handles_a_degenerate_flat_window() -> None:
    candidate = opened(metrics(window_high=110.0, window_low=110.0))
    assert candidate.impulse_origin == candidate.impulse_extreme == 110.0
    assert retrace_fraction(candidate, 109.0) == 0.0


# ── state transitions ────────────────────────────────────────────────────────


def test_momentum_holds_while_price_extends() -> None:
    candidate = advance_candidate(opened(), metrics(price=112.0), T0 + 10)
    assert candidate.state == "MOMENTUM"
    assert candidate.impulse_extreme == 112.0
    assert candidate.retrace_pct == 0.0


def test_momentum_to_pullback_on_retracement() -> None:
    candidate = advance_candidate(
        opened(), metrics(price=107.0, change_1m_pct=-0.5, rvol_1m=0.8), T0 + 60
    )
    assert candidate.state == "PULLBACK"
    assert candidate.retrace_pct == pytest.approx(30.0)
    assert candidate.pullback_extreme == 107.0
    assert candidate.history[-1].from_state == "MOMENTUM"


def test_healthy_pullback_flags() -> None:
    candidate = advance_candidate(
        opened(), metrics(price=107.0, change_1m_pct=-0.4, rvol_1m=0.7), T0 + 60
    )
    assert candidate.health == {
        "volume_cooling": True,
        "shallow": True,
        "structure_intact": True,
        "no_opposing": True,
    }


def test_unhealthy_pullback_is_flagged_but_not_yet_invalid() -> None:
    """Deep-but-survivable + hot volume: still PULLBACK, honestly labelled."""
    candidate = advance_candidate(
        opened(), metrics(price=104.0, change_1m_pct=-0.6, rvol_1m=3.0), T0 + 60
    )
    assert candidate.state == "PULLBACK"
    assert candidate.health["volume_cooling"] is False
    assert candidate.health["shallow"] is False
    assert candidate.health["structure_intact"] is True


def test_pullback_to_continuation_requires_reclaim_and_volume() -> None:
    pullback = advance_candidate(
        opened(), metrics(price=107.0, change_1m_pct=-0.5, rvol_1m=0.8), T0 + 60
    )
    confirmed = advance_candidate(
        pullback, metrics(price=109.5, change_1m_pct=0.6, rvol_1m=2.5), T0 + 120
    )
    assert confirmed.state == "CONTINUATION"
    assert confirmed.history[-1].reason == "reclaimed the pullback on returning volume"


def test_pullback_stays_put_without_a_continuation_event() -> None:
    """Still green is not continuation: each leg of the confirmation is
    independently required."""
    pullback = advance_candidate(
        opened(), metrics(price=107.0, change_1m_pct=-0.5, rvol_1m=0.8), T0 + 60
    )
    # Price drifting up but short of the reclaim level.
    assert (
        advance_candidate(pullback, metrics(price=108.0, change_1m_pct=0.6, rvol_1m=2.5), T0 + 120).state
        == "PULLBACK"
    )
    # Reclaimed, but on dead volume.
    assert (
        advance_candidate(pullback, metrics(price=109.5, change_1m_pct=0.6, rvol_1m=0.9), T0 + 120).state
        == "PULLBACK"
    )
    # Reclaimed on volume, but no fresh displacement.
    assert (
        advance_candidate(pullback, metrics(price=109.5, change_1m_pct=0.05, rvol_1m=2.5), T0 + 120).state
        == "PULLBACK"
    )


def test_continuation_can_fall_back_to_pullback() -> None:
    pullback = advance_candidate(
        opened(), metrics(price=107.0, change_1m_pct=-0.5, rvol_1m=0.8), T0 + 60
    )
    confirmed = advance_candidate(
        pullback, metrics(price=112.0, change_1m_pct=0.9, rvol_1m=2.5), T0 + 120
    )
    assert confirmed.state == "CONTINUATION"
    assert confirmed.impulse_extreme == 112.0
    again = advance_candidate(
        confirmed, metrics(price=108.0, change_1m_pct=-0.5, rvol_1m=0.8), T0 + 180
    )
    assert again.state == "PULLBACK"


def test_full_transition_history_is_inspectable() -> None:
    candidate = opened()
    candidate = advance_candidate(
        candidate, metrics(price=107.0, change_1m_pct=-0.5, rvol_1m=0.8), T0 + 60
    )
    candidate = advance_candidate(
        candidate, metrics(price=109.5, change_1m_pct=0.6, rvol_1m=2.5), T0 + 120
    )
    candidate = advance_candidate(
        candidate, metrics(price=99.0, change_1m_pct=-0.5, rvol_1m=1.0), T0 + 180
    )
    assert [t.to_state for t in candidate.history] == [
        "MOMENTUM",
        "PULLBACK",
        "CONTINUATION",
        "INVALID",
    ]
    assert all(t.reason for t in candidate.history)


def test_advance_never_mutates_its_input() -> None:
    candidate = opened()
    before = (candidate.state, candidate.impulse_extreme, len(candidate.history))
    advance_candidate(candidate, metrics(price=99.0, change_1m_pct=-0.5), T0 + 60)
    assert (candidate.state, candidate.impulse_extreme, len(candidate.history)) == before


def test_advance_is_deterministic() -> None:
    candidate = opened()
    read = metrics(price=107.0, change_1m_pct=-0.5, rvol_1m=0.8)
    first = advance_candidate(candidate, read, T0 + 60)
    second = advance_candidate(candidate, read, T0 + 60)
    assert first == second


# ── invalidation ─────────────────────────────────────────────────────────────


def test_invalid_when_retracement_exceeds_threshold() -> None:
    candidate = advance_candidate(
        opened(), metrics(price=103.0, change_1m_pct=-0.5, rvol_1m=1.0), T0 + 60
    )
    assert candidate.state == "INVALID"
    assert candidate.reason == "pullback exceeded threshold"


def test_invalid_when_the_impulse_base_is_lost() -> None:
    candidate = advance_candidate(
        opened(), metrics(price=99.0, change_1m_pct=-0.5, rvol_1m=1.0), T0 + 60
    )
    assert candidate.state == "INVALID"
    assert candidate.reason == "structure broken — impulse base lost"


def test_invalid_on_strong_opposing_displacement() -> None:
    """A hard counter-move kills the candidate even though the retracement is
    still shallow."""
    candidate = advance_candidate(
        opened(), metrics(price=109.0, change_1m_pct=-1.5, rvol_1m=3.0), T0 + 30
    )
    assert candidate.state == "INVALID"
    assert candidate.reason == "strong opposing displacement"
    assert candidate.retrace_pct == pytest.approx(10.0)


def test_opposing_displacement_needs_volume_behind_it() -> None:
    candidate = advance_candidate(
        opened(), metrics(price=109.0, change_1m_pct=-1.5, rvol_1m=0.5), T0 + 30
    )
    assert candidate.state == "MOMENTUM"


def test_invalid_is_terminal() -> None:
    dead = advance_candidate(opened(), metrics(price=99.0, change_1m_pct=-0.5), T0 + 60)
    assert dead.state == "INVALID"
    revived = advance_candidate(dead, metrics(price=120.0, change_1m_pct=2.0, rvol_1m=6.0), T0 + 90)
    assert revived is dead


# ── staleness ────────────────────────────────────────────────────────────────


def test_stale_candidate_invalidates() -> None:
    candidate = advance_candidate(
        opened(),
        metrics(ts=T0 + 400, price=110.0, change_1m_pct=0.0, last_meaningful_ts=T0),
        T0 + 400,
    )
    assert candidate.state == "INVALID"
    assert candidate.reason == "went stale — no meaningful tape"


def test_recent_tape_keeps_a_candidate_alive() -> None:
    candidate = advance_candidate(
        opened(),
        metrics(ts=T0 + 400, price=110.0, change_1m_pct=0.0, last_meaningful_ts=T0 + 380),
        T0 + 400,
    )
    assert candidate.state == "MOMENTUM"


def test_expire_candidate_covers_symbols_that_stopped_ticking() -> None:
    candidate = opened()
    assert expire_candidate(candidate, T0 + 100).state == "MOMENTUM"
    expired = expire_candidate(candidate, T0 + DEFAULT_CONFIG.stale_seconds + 1)
    assert expired.state == "INVALID"
    assert expired.reason == "went stale — no meaningful tape"


def test_invalid_candidates_drop_after_their_ttl() -> None:
    dead = advance_candidate(opened(), metrics(price=99.0, change_1m_pct=-0.5), T0 + 60)
    assert should_drop(dead, T0 + 60) is False
    assert should_drop(dead, T0 + 60 + DEFAULT_CONFIG.invalid_ttl_seconds) is True
    assert should_drop(opened(), T0 + 10_000) is False


# ── symmetry ─────────────────────────────────────────────────────────────────


def test_bullish_and_bearish_score_identically() -> None:
    bull, bull_components = momentum_score(metrics(), "bullish")
    bear, bear_components = momentum_score(mirrored(metrics()), "bearish")
    assert bull == bear
    assert bull_components == bear_components


@pytest.mark.parametrize(
    ("price", "change_1m", "rvol_1m", "expected"),
    [
        (112.0, 0.9, 3.0, "MOMENTUM"),
        (107.0, -0.5, 0.8, "PULLBACK"),
        (103.0, -0.5, 1.0, "INVALID"),
        (109.0, -1.5, 3.0, "INVALID"),
    ],
)
def test_state_machine_is_direction_symmetric(
    price: float, change_1m: float, rvol_1m: float, expected: str
) -> None:
    bull_read = metrics(price=price, change_1m_pct=change_1m, rvol_1m=rvol_1m)
    bull = advance_candidate(opened(), bull_read, T0 + 60)
    bear = advance_candidate(opened(mirrored(metrics())), mirrored(bull_read), T0 + 60)
    assert bull.state == bear.state == expected
    assert bull.reason == bear.reason
    assert bull.retrace_pct == pytest.approx(bear.retrace_pct)


def test_bearish_continuation_mirrors_bullish() -> None:
    pullback = advance_candidate(
        opened(mirrored(metrics())),
        mirrored(metrics(price=107.0, change_1m_pct=-0.5, rvol_1m=0.8)),
        T0 + 60,
    )
    assert pullback.state == "PULLBACK"
    confirmed = advance_candidate(
        pullback, mirrored(metrics(price=109.5, change_1m_pct=0.6, rvol_1m=2.5)), T0 + 120
    )
    assert confirmed.state == "CONTINUATION"
    assert confirmed.direction == "bearish"


# ── ranking ──────────────────────────────────────────────────────────────────


def _scored(symbol: str, score: float, updated_at: float) -> Candidate:
    return replace(opened(), symbol=symbol, score=score, updated_at=updated_at)


def test_ranking_is_by_score_then_freshness_then_symbol() -> None:
    ordered = rank(
        [
            _scored("AAA", 50.0, T0),
            _scored("BBB", 90.0, T0),
            _scored("CCC", 90.0, T0 + 30),
        ]
    )
    assert [c.symbol for c in ordered] == ["CCC", "BBB", "AAA"]


def test_ranking_is_stable_across_repeated_calls() -> None:
    """A total ordering — no two candidates ever compare equal — so the card
    grid never reshuffles between identical ticks."""
    pool = [_scored(s, 80.0, T0) for s in ("DDD", "AAA", "CCC", "BBB")]
    first = [c.symbol for c in rank(pool)]
    assert first == ["AAA", "BBB", "CCC", "DDD"]
    assert first == [c.symbol for c in rank(list(reversed(pool)))]
