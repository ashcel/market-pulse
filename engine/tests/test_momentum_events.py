"""MOMENTUM RADAR durable event layer.

The contract these tests defend is *stability*. Raw flow is allowed to change
every tick; what the UI reads must not. Specifically:

* an event is minted once and keeps its identity and `ts` through refreshes;
* it survives the condition normalizing (hysteresis, then a TTL);
* tracker state only ever moves forward, and never twice inside the dwell;
* ranking does not reshuffle on sub-bucket score noise;
* bullish and bearish are exact mirrors.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from smc.momentum import DEFAULT_CONFIG, WindowMetrics, detect_momentum, open_candidate
from smc.momentum_events import (
    DEFAULT_EVENT_CONFIG,
    EventConfig,
    MarketEvent,
    SymbolTracker,
    _score_tracker,
    advance_tracker,
    evaluate_conditions,
    qualify,
    rank_trackers,
    should_drop_tracker,
    structural_events,
)

T0 = 1_700_000_000.0
CFG = DEFAULT_EVENT_CONFIG


def metrics(**overrides: object) -> WindowMetrics:
    """A symbol mid-anomaly: +1.6% over 3m on 5.7x relative volume."""
    base = dict(
        symbol="TST",
        ts=T0,
        price=110.0,
        change_1m_pct=0.8,
        change_3m_pct=1.6,
        change_5m_pct=2.0,
        change_15m_pct=2.4,
        rvol_1m=5.7,
        rvol_3m=5.7,
        rvol_5m=3.0,
        trade_rate_mult=3.0,
        range_expansion=1.0,
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
    """The same tape with every price move flipped — volume is unsigned."""
    flip = lambda v: None if v is None else -v  # noqa: E731
    return replace(
        m,
        change_1m_pct=flip(m.change_1m_pct),
        change_3m_pct=flip(m.change_3m_pct),
        change_5m_pct=flip(m.change_5m_pct),
        change_15m_pct=flip(m.change_15m_pct),
        change_24h_pct=-m.change_24h_pct,
    )


def quiet(**overrides: object) -> WindowMetrics:
    """Nothing happening: baseline volume, no move."""
    base: dict[str, object] = dict(
        change_1m_pct=0.02,
        change_3m_pct=0.05,
        change_5m_pct=0.05,
        rvol_1m=1.0,
        rvol_3m=1.0,
        trade_rate_mult=1.0,
        range_expansion=1.0,
    )
    base.update(overrides)
    return metrics(**base)


def open_tracker(m: WindowMetrics | None = None, ts: float = T0) -> SymbolTracker:
    tracker = advance_tracker(None, m if m is not None else metrics(), ts, CFG)
    assert tracker is not None
    return tracker


def types_of(tracker: SymbolTracker) -> set[str]:
    return {event.type for event in tracker.events}


# ── volume anomaly detection ─────────────────────────────────────────────────


def test_a_volume_spike_mints_a_volume_anomaly_event() -> None:
    tracker = open_tracker()
    anomaly = next(e for e in tracker.events if e.type == "VOLUME_ANOMALY")
    assert anomaly.magnitude == pytest.approx(5.7)
    assert anomaly.unit == "x"
    assert anomaly.ts == T0
    assert anomaly.is_active(T0, CFG)
    # It carries the concurrent price direction so the card can describe it.
    assert anomaly.direction == "bullish"


def test_ordinary_volume_never_mints_an_anomaly() -> None:
    assert advance_tracker(None, quiet(), T0, CFG) is None


def test_the_anomaly_score_scales_with_how_abnormal_the_volume_is() -> None:
    small = evaluate_conditions(metrics(rvol_3m=3.1, rvol_1m=3.1), CFG)["VOLUME_ANOMALY"]
    large = evaluate_conditions(metrics(rvol_3m=8.0, rvol_1m=8.0), CFG)["VOLUME_ANOMALY"]
    assert small.score < large.score
    assert small.score >= CFG.event_score_floor
    assert large.score == pytest.approx(100.0)


def test_an_anomaly_uses_the_steadier_3m_relative_volume() -> None:
    """A 1m spike alone must not fire it — that is exactly the noise the layer
    exists to absorb."""
    read = evaluate_conditions(metrics(rvol_1m=9.0, rvol_3m=1.2), CFG)["VOLUME_ANOMALY"]
    assert read.fires is False


# ── event persistence + hysteresis ───────────────────────────────────────────


def test_an_event_survives_the_volume_normalizing() -> None:
    """The whole point: 5.7x drops to 1.1x and the event is still there."""
    tracker = open_tracker()
    minted = next(e for e in tracker.events if e.type == "VOLUME_ANOMALY")

    tracker = advance_tracker(tracker, quiet(ts=T0 + 2), T0 + 2, CFG)
    assert tracker is not None
    still = next(e for e in tracker.events if e.type == "VOLUME_ANOMALY")
    # Same event, same identity, same detection time.
    assert still.ts == minted.ts
    assert still.peak_magnitude == pytest.approx(5.7)
    # …but honestly reported as no longer describing the current tick.
    assert still.is_active(T0 + 60, CFG) is False


def test_hysteresis_keeps_an_event_active_between_the_clear_and_fire_bands() -> None:
    tracker = open_tracker()
    # 2.2x is below the 3.0 fire threshold but above the 1.8 clear threshold.
    between = metrics(rvol_1m=2.2, rvol_3m=2.2, ts=T0 + 2)
    tracker = advance_tracker(tracker, between, T0 + 2, CFG)
    assert tracker is not None
    anomaly = next(e for e in tracker.events if e.type == "VOLUME_ANOMALY")
    assert anomaly.is_active(T0 + 2, CFG) is True
    assert anomaly.last_seen_ts == T0 + 2
    assert anomaly.ts == T0


def test_a_condition_oscillating_around_its_threshold_mints_one_event_only() -> None:
    """Fire 3.0 / clear 1.8: bouncing 2.5 <-> 3.4 must not strobe the card."""
    tracker = open_tracker()
    now = T0
    for step in range(20):
        now += 2
        rvol = 3.4 if step % 2 == 0 else 2.5
        tracker = advance_tracker(tracker, metrics(rvol_1m=rvol, rvol_3m=rvol, ts=now), now, CFG)
        assert tracker is not None
    anomalies = [e for e in tracker.timeline if e.type == "VOLUME_ANOMALY"]
    assert len(anomalies) == 1
    assert anomalies[0].ts == T0


def test_a_re_fire_is_allowed_once_the_first_event_has_fully_expired() -> None:
    tracker = open_tracker()
    cold = T0 + CFG.event_ttl_seconds + 10
    tracker = advance_tracker(tracker, quiet(ts=cold), cold, CFG)
    assert tracker is not None
    assert types_of(tracker) == set()

    hot = cold + 2
    tracker = advance_tracker(tracker, metrics(ts=hot), hot, CFG)
    assert tracker is not None
    anomalies = [e for e in tracker.timeline if e.type == "VOLUME_ANOMALY"]
    assert len(anomalies) == 2
    assert anomalies[-1].ts == hot


def test_a_live_events_magnitude_tracks_the_tape_while_its_peak_is_kept() -> None:
    tracker = open_tracker()
    hotter = metrics(rvol_1m=7.5, rvol_3m=7.5, ts=T0 + 2)
    tracker = advance_tracker(tracker, hotter, T0 + 2, CFG)
    assert tracker is not None
    anomaly = next(e for e in tracker.events if e.type == "VOLUME_ANOMALY")
    assert anomaly.magnitude == pytest.approx(7.5)
    assert anomaly.peak_magnitude == pytest.approx(7.5)

    cooler = metrics(rvol_1m=3.2, rvol_3m=3.2, ts=T0 + 4)
    tracker = advance_tracker(tracker, cooler, T0 + 4, CFG)
    assert tracker is not None
    anomaly = next(e for e in tracker.events if e.type == "VOLUME_ANOMALY")
    assert anomaly.magnitude == pytest.approx(3.2)
    assert anomaly.peak_magnitude == pytest.approx(7.5)


# ── stale expiration ─────────────────────────────────────────────────────────


def test_an_event_expires_a_ttl_after_its_condition_last_held() -> None:
    tracker = open_tracker()
    warm = T0 + CFG.event_ttl_seconds - 5
    tracker = advance_tracker(tracker, quiet(ts=warm), warm, CFG)
    assert tracker is not None and "VOLUME_ANOMALY" in types_of(tracker)

    cold = T0 + CFG.event_ttl_seconds + 1
    tracker = advance_tracker(tracker, quiet(ts=cold), cold, CFG)
    assert tracker is not None
    assert types_of(tracker) == set()
    # Expired from the live set, but never from the record of what happened.
    assert [e.type for e in tracker.timeline] == [
        "VOLUME_ANOMALY",
        "PRICE_DISPLACEMENT",
        "TRADE_RATE_EXPANSION",
    ]


def test_a_tracker_outlives_its_last_event_by_the_grace_period_then_drops() -> None:
    tracker = open_tracker()
    cold = T0 + CFG.event_ttl_seconds + 1
    tracker = advance_tracker(tracker, quiet(ts=cold), cold, CFG)
    assert tracker is not None
    assert tracker.events == ()

    # Grace runs from the last tick that still had a live event.
    base = tracker.last_active_ts
    assert should_drop_tracker(tracker, base + CFG.tracker_grace_seconds - 5, CFG) is False
    assert should_drop_tracker(tracker, base + CFG.tracker_grace_seconds + 1, CFG) is True


def test_a_faded_tracker_is_dropped_on_its_own_ttl() -> None:
    tracker = open_tracker()
    hit = T0 + CFG.min_state_seconds + 2
    tracker = advance_tracker(tracker, metrics(change_3m_pct=-1.5, ts=hit), hit, CFG)
    assert tracker is not None and tracker.state == "FADED"
    assert should_drop_tracker(tracker, hit + CFG.faded_ttl_seconds - 5, CFG) is False
    assert should_drop_tracker(tracker, hit + CFG.faded_ttl_seconds + 1, CFG) is True


# ── state transitions ────────────────────────────────────────────────────────


def test_a_first_event_opens_the_tracker_as_new() -> None:
    tracker = open_tracker(metrics(range_expansion=1.0))
    assert tracker.state == "NEW"
    assert tracker.state_since == tracker.first_event_at


def test_new_becomes_developing_once_several_event_types_corroborate() -> None:
    """One anomaly is news; an anomaly plus displacement plus a volatility
    expansion is a situation forming."""
    tracker = open_tracker()
    assert tracker.state == "NEW"
    later = T0 + CFG.min_state_seconds + 2
    tracker = advance_tracker(tracker, metrics(range_expansion=3.0, ts=later), later, CFG)
    assert tracker is not None
    assert len(types_of(tracker)) >= CFG.developing_min_event_types
    assert tracker.state == "DEVELOPING"


def test_a_lone_event_never_ages_into_developing() -> None:
    """Age is not evidence. A volume spike nobody traded against is the same
    observation an hour later — it must not drift into DEVELOPING just by
    surviving."""
    lone = dict(change_3m_pct=0.1, range_expansion=1.0, trade_rate_mult=1.0)
    tracker = open_tracker(metrics(**lone))
    assert types_of(tracker) == {"VOLUME_ANOMALY"}
    assert tracker.qualification.qualified is False

    aged = T0 + CFG.new_window_seconds + 2
    tracker = advance_tracker(tracker, metrics(ts=aged, **lone), aged, CFG)
    assert tracker is not None
    assert tracker.state == "NEW"


def test_confirmed_requires_a_structural_event() -> None:
    tracker = open_tracker()
    later = T0 + CFG.min_state_seconds + 2
    # No structural consequence yet, however long the flow persists.
    for _ in range(5):
        later += CFG.min_state_seconds
        tracker = advance_tracker(tracker, metrics(range_expansion=3.0, ts=later), later, CFG)
        assert tracker is not None
    assert tracker.state == "DEVELOPING"

    later += CFG.min_state_seconds
    tracker = advance_tracker(
        tracker,
        metrics(ts=later),
        later,
        CFG,
        structural=[_structural("CONTINUATION", later)],
    )
    assert tracker is not None
    assert tracker.state == "CONFIRMED"


def test_state_never_walks_backwards() -> None:
    """A confirmed situation whose flow goes quiet stays confirmed until it
    expires — it does not demote itself to NEW and reshuffle the page."""
    tracker = open_tracker()
    now = T0 + CFG.min_state_seconds + 2
    tracker = advance_tracker(
        tracker, metrics(ts=now), now, CFG, structural=[_structural("STRUCTURE_BREAK", now)]
    )
    assert tracker is not None and tracker.state == "CONFIRMED"

    for _ in range(10):
        now += 5
        tracker = advance_tracker(tracker, quiet(ts=now), now, CFG)
        assert tracker is not None
        assert tracker.state == "CONFIRMED"


def test_no_two_promotions_inside_the_dwell_window() -> None:
    """Dwell is what stops a section strobing: an eventful couple of seconds
    may advance the tracker once, not twice."""
    tracker = open_tracker()
    early = T0 + CFG.min_state_seconds / 2
    tracker = advance_tracker(
        tracker,
        metrics(range_expansion=3.0, ts=early),
        early,
        CFG,
        structural=[_structural("CONTINUATION", early)],
    )
    assert tracker is not None
    assert tracker.state == "NEW"

    after = T0 + CFG.min_state_seconds + 1
    tracker = advance_tracker(tracker, metrics(ts=after), after, CFG)
    assert tracker is not None
    assert tracker.state == "CONFIRMED"


def test_a_hard_counter_move_fades_the_tracker() -> None:
    tracker = open_tracker()
    now = T0 + CFG.min_state_seconds + 2
    against = metrics(change_1m_pct=-1.2, change_3m_pct=-1.4, ts=now)
    tracker = advance_tracker(tracker, against, now, CFG)
    assert tracker is not None
    assert tracker.state == "FADED"
    assert "INVALIDATION" in types_of(tracker)
    # The established direction is not rewritten by the move that killed it.
    assert tracker.direction == "bullish"


def test_faded_is_terminal() -> None:
    tracker = open_tracker()
    now = T0 + CFG.min_state_seconds + 2
    tracker = advance_tracker(tracker, metrics(change_3m_pct=-1.5, ts=now), now, CFG)
    assert tracker is not None and tracker.state == "FADED"
    now += CFG.min_state_seconds + 2
    tracker = advance_tracker(tracker, metrics(ts=now), now, CFG)
    assert tracker is not None
    assert tracker.state == "FADED"


def test_a_mild_counter_move_is_not_an_invalidation() -> None:
    tracker = open_tracker()
    now = T0 + 2
    tracker = advance_tracker(tracker, metrics(change_3m_pct=-0.3, ts=now), now, CFG)
    assert tracker is not None
    assert tracker.state == "NEW"
    assert "INVALIDATION" not in types_of(tracker)


# ── the timeline ─────────────────────────────────────────────────────────────


def test_the_timeline_records_the_sequence_in_order() -> None:
    tracker = open_tracker()
    now = T0 + 30
    tracker = advance_tracker(
        tracker, metrics(ts=now), now, CFG, structural=[_structural("PULLBACK", now)]
    )
    assert tracker is not None
    now += 30
    tracker = advance_tracker(
        tracker,
        metrics(ts=now),
        now,
        CFG,
        structural=[_structural("CONTINUATION", now)],
    )
    assert tracker is not None
    assert [e.type for e in tracker.timeline] == [
        "VOLUME_ANOMALY",
        "PRICE_DISPLACEMENT",
        "TRADE_RATE_EXPANSION",
        "PULLBACK",
        "CONTINUATION",
    ]
    assert [e.ts for e in tracker.timeline] == sorted(e.ts for e in tracker.timeline)


def test_the_timeline_is_capped() -> None:
    config = replace(CFG, timeline_max=3)
    tracker = advance_tracker(None, metrics(), T0, config)
    assert tracker is not None
    now = T0
    for _ in range(6):
        now += 30
        tracker = advance_tracker(
            tracker, metrics(ts=now), now, config, structural=[_structural("PULLBACK", now)]
        )
        assert tracker is not None
    assert len(tracker.timeline) == 3


def test_structural_events_are_derived_from_state_machine_transitions() -> None:
    m = metrics()
    signal = detect_momentum(m, DEFAULT_CONFIG)
    assert signal is not None
    candidate = open_candidate(m, signal)
    pulled_back = replace(
        candidate,
        state="PULLBACK",
        retrace_pct=32.0,
        history=(
            *candidate.history,
            _transition(T0 + 20, "MOMENTUM", "PULLBACK"),
        ),
    )
    derived = structural_events(candidate, pulled_back, CFG)
    assert [e.type for e in derived] == ["PULLBACK"]
    assert derived[0].magnitude == pytest.approx(32.0)
    assert derived[0].direction == "bullish"


def test_a_new_extreme_after_a_pullback_is_a_structure_break() -> None:
    m = metrics()
    signal = detect_momentum(m, DEFAULT_CONFIG)
    assert signal is not None
    candidate = replace(open_candidate(m, signal), state="PULLBACK")
    broken = replace(candidate, impulse_extreme=candidate.impulse_extreme + 1.0)
    derived = structural_events(candidate, broken, CFG)
    assert [e.type for e in derived] == ["STRUCTURE_BREAK"]
    assert derived[0].qualifier == "HH"


# ── ranking stability ────────────────────────────────────────────────────────


def _tracker(symbol: str, score: float, first: float) -> SymbolTracker:
    return SymbolTracker(
        symbol=symbol,
        state="DEVELOPING",
        direction="bullish",
        events=(),
        timeline=(),
        raw_score=score,
        display_score=score,
        peak_score=score,
        first_event_at=first,
        last_event_at=first,
        last_active_ts=first,
        state_since=first,
        updated_at=first,
    )


def test_ranking_does_not_reshuffle_on_sub_bucket_noise() -> None:
    before = [
        _tracker("AAA", 71.0, T0),
        _tracker("BBB", 69.5, T0 + 5),
        _tracker("CCC", 68.2, T0 + 10),
    ]
    assert [t.symbol for t in rank_trackers(before, CFG)] == ["AAA", "BBB", "CCC"]

    # Every score wiggles, none crosses a bucket edge: the order must hold.
    after = [
        replace(before[0], display_score=70.2),
        replace(before[1], display_score=69.9),
        replace(before[2], display_score=68.8),
    ]
    assert [t.symbol for t in rank_trackers(after, CFG)] == ["AAA", "BBB", "CCC"]


def test_a_genuinely_stronger_candidate_still_overtakes() -> None:
    trackers = [_tracker("AAA", 71.0, T0), _tracker("BBB", 88.0, T0 + 5)]
    assert [t.symbol for t in rank_trackers(trackers, CFG)] == ["BBB", "AAA"]


def test_inside_a_bucket_the_incumbent_keeps_its_place() -> None:
    """Age is the tiebreak, and age cannot move — so a newcomer with the same
    bucketed score appears below rather than displacing what is on screen."""
    trackers = [_tracker("NEWER", 72.4, T0 + 60), _tracker("OLDER", 71.1, T0)]
    assert [t.symbol for t in rank_trackers(trackers, CFG)] == ["OLDER", "NEWER"]


def test_the_display_score_is_smoothed_rather_than_jumping() -> None:
    tracker = open_tracker(metrics(rvol_1m=8.0, rvol_3m=8.0))
    peak = tracker.display_score
    now = T0 + 2
    tracker = advance_tracker(tracker, metrics(rvol_1m=3.1, rvol_3m=3.1, ts=now), now, CFG)
    assert tracker is not None
    # Raw collapses; the number on the card only drifts toward it.
    assert tracker.raw_score < tracker.display_score < peak


# ── symmetry ─────────────────────────────────────────────────────────────────


def test_bullish_and_bearish_tapes_produce_mirrored_events() -> None:
    bull = open_tracker()
    bear = open_tracker(mirrored(metrics()))

    assert types_of(bull) == types_of(bear)
    assert bull.state == bear.state
    assert bull.display_score == pytest.approx(bear.display_score)
    assert bull.direction == "bullish"
    assert bear.direction == "bearish"

    bull_move = next(e for e in bull.events if e.type == "PRICE_DISPLACEMENT")
    bear_move = next(e for e in bear.events if e.type == "PRICE_DISPLACEMENT")
    assert bull_move.magnitude == pytest.approx(-bear_move.magnitude)
    assert bull_move.score == pytest.approx(bear_move.score)


def test_invalidation_is_symmetric() -> None:
    bull = open_tracker()
    bear = open_tracker(mirrored(metrics()))
    now = T0 + CFG.min_state_seconds + 2

    bull = advance_tracker(bull, metrics(change_3m_pct=-1.4, ts=now), now, CFG)
    bear = advance_tracker(bear, mirrored(metrics(change_3m_pct=-1.4)), now, CFG)
    assert bull is not None and bear is not None
    assert bull.state == bear.state == "FADED"


def test_headline_prefers_an_active_event_over_a_lingering_one() -> None:
    tracker = open_tracker()
    # The anomaly goes quiet; a fresh volatility expansion takes over.
    later = T0 + CFG.event_active_seconds + 5
    tracker = advance_tracker(
        tracker,
        quiet(range_expansion=4.0, ts=later),
        later,
        CFG,
    )
    assert tracker is not None
    headline = tracker.headline(later, CFG)
    assert headline is not None
    assert headline.type == "VOLATILITY_EXPANSION"


def test_event_config_rejects_an_inverted_hysteresis_band() -> None:
    with pytest.raises(ValueError, match="clear threshold"):
        EventConfig(volume_anomaly_fire_rvol=2.0, volume_anomaly_clear_rvol=3.0)


# ── helpers ──────────────────────────────────────────────────────────────────


def _structural(event_type: str, ts: float) -> MarketEvent:
    return MarketEvent(
        symbol="TST",
        type=event_type,  # type: ignore[arg-type]
        direction="bullish",
        ts=ts,
        last_seen_ts=ts,
        magnitude=1.0,
        peak_magnitude=1.0,
        unit="%",
        score=CFG.continuation_score,
        peak_score=CFG.continuation_score,
    )


def _transition(ts: float, from_state: str, to_state: str):  # type: ignore[no-untyped-def]
    from smc.momentum import Transition

    return Transition(ts=ts, from_state=from_state, to_state=to_state, reason="test")  # type: ignore[arg-type]


# ── qualification: relationships, not lone observations ──────────────────────


def only(*types: str, ts: float = T0) -> tuple[MarketEvent, ...]:
    """Live events of exactly these types, all equally severe."""
    return tuple(
        MarketEvent(
            symbol="TST",
            type=name,  # type: ignore[arg-type]
            direction="bullish",
            ts=ts,
            last_seen_ts=ts,
            magnitude=1.0,
            peak_magnitude=1.0,
            unit="x",
            score=80.0,
            peak_score=80.0,
        )
        for name in types
    )


def test_a_lone_displacement_does_not_qualify() -> None:
    """A move nobody is trading is a move, not a situation."""
    assert qualify(only("PRICE_DISPLACEMENT")).qualified is False


def test_a_lone_volume_anomaly_does_not_qualify() -> None:
    assert qualify(only("VOLUME_ANOMALY")).qualified is False


def test_two_events_from_the_same_family_do_not_qualify() -> None:
    """Volume and trade rate are two views of the same crowd — corroborating
    yourself is not corroboration."""
    result = qualify(only("VOLUME_ANOMALY", "TRADE_RATE_EXPANSION"))
    assert result.qualified is False
    assert result.families == ("PARTICIPATION",)


def test_displacement_with_participation_qualifies() -> None:
    result = qualify(only("PRICE_DISPLACEMENT", "VOLUME_ANOMALY"))
    assert result.qualified is True
    assert result.combo == "displacement+participation"
    assert result.tier == "MEDIUM"


def test_an_anomaly_with_a_price_response_qualifies_weakly() -> None:
    result = qualify(only("VOLUME_ANOMALY", "VOLATILITY_EXPANSION"))
    assert result.qualified is True
    assert result.combo == "anomaly+response"
    assert result.tier == "LOW"


def test_a_structural_break_with_activity_qualifies() -> None:
    result = qualify(only("CHOCH", "VOLUME_ANOMALY"))
    assert result.qualified is True
    assert result.combo == "structure+activity"


def test_the_full_story_earns_the_top_tier() -> None:
    result = qualify(only("PRICE_DISPLACEMENT", "VOLUME_ANOMALY", "CHOCH"))
    assert result.tier == "HIGH"
    assert result.combo == "structure+activity"


def test_a_structural_event_alone_does_not_qualify() -> None:
    assert qualify(only("CHOCH")).qualified is False


def test_cooling_and_pullback_are_not_evidence_of_a_new_situation() -> None:
    assert qualify(only("VOLUME_COOLING", "PULLBACK")).qualified is False
    assert qualify(only("PRICE_DISPLACEMENT", "VOLUME_COOLING")).qualified is False


# ── scoring from independent evidence only ───────────────────────────────────


def test_one_family_can_never_reach_the_top_of_the_scale() -> None:
    """The 100/100 problem: a single extreme reading is one fact, not a
    complete picture."""
    maxed = tuple(replace(event, score=100.0) for event in only("VOLUME_ANOMALY"))
    assert _score_tracker(maxed, CFG) < 60.0


def test_more_independent_families_score_higher_than_the_same_severity_alone() -> None:
    one = tuple(replace(e, score=90.0) for e in only("VOLUME_ANOMALY"))
    three = tuple(
        replace(e, score=90.0)
        for e in only("VOLUME_ANOMALY", "PRICE_DISPLACEMENT", "CHOCH")
    )
    assert _score_tracker(three, CFG) > _score_tracker(one, CFG)


def test_a_second_event_from_the_same_family_adds_nothing_to_the_score() -> None:
    alone = tuple(replace(e, score=80.0) for e in only("VOLUME_ANOMALY"))
    doubled = tuple(replace(e, score=80.0) for e in only("VOLUME_ANOMALY", "TRADE_RATE_EXPANSION"))
    assert _score_tracker(doubled, CFG) == _score_tracker(alone, CFG)


def test_family_less_events_contribute_nothing() -> None:
    assert _score_tracker(only("VOLUME_COOLING", "PULLBACK"), CFG) == 0.0


# ── volume cooling is flow, not state ────────────────────────────────────────


def test_cooling_never_fires_outside_a_pullback() -> None:
    """Quiet volume on a symbol that is not retracing is just a quiet minute."""
    reads = evaluate_conditions(
        quiet(rvol_1m=0.5, rvol_3m=0.5), CFG, had_anomaly=True, in_pullback=False
    )
    assert "VOLUME_COOLING" not in reads


def test_cooling_fires_during_a_pullback_after_a_real_impulse() -> None:
    reads = evaluate_conditions(
        quiet(rvol_1m=0.5, rvol_3m=0.5), CFG, had_anomaly=True, in_pullback=True
    )
    assert reads["VOLUME_COOLING"].fires is True


def test_cooling_needs_a_prior_anomaly_as_well_as_a_pullback() -> None:
    reads = evaluate_conditions(
        quiet(rvol_1m=0.5, rvol_3m=0.5), CFG, had_anomaly=False, in_pullback=True
    )
    assert "VOLUME_COOLING" not in reads
