"""EVENT AGGREGATOR + SCAN PROFILES + JOURNAL.

The compression layer. What is pinned:

* the lifecycle only advances on structural evidence, with dwell, and never
  walks backwards on noise;
* `worth_watching` is a *rejection* function — an empty radar is a valid
  outcome, and it always says why;
* a short structural path removes a candidate rather than decorating it;
* ranking does not churn;
* scalp and intraday read the same tape at different horizons;
* every surfaced situation is recorded deterministically for later measurement.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from smc.context_alignment import Alignment
from smc.market_context import MarketContext, TimeframeRead
from smc.momentum import Candidate, WindowMetrics, detect_momentum, open_candidate
from smc.momentum_events import MarketEvent, SymbolTracker, advance_tracker
from smc.scan_profiles import INTRADAY, MODES, SCALP, profile_for
from smc.situation import Situation, advance_situation, rank_situations, surfaced
from smc.situation_journal import SituationJournal
from smc.structure_map import StructuralLevel, StructureMap

T0 = 1_700_000_000.0


# ── fixtures ─────────────────────────────────────────────────────────────────


def metrics(**overrides: object) -> WindowMetrics:
    """A symbol mid-impulse: -2% over 3m on 5x relative volume."""
    base: dict[str, object] = dict(
        symbol="TST",
        ts=T0,
        price=98.0,
        change_1m_pct=-0.9,
        change_3m_pct=-2.0,
        change_5m_pct=-2.4,
        change_15m_pct=-2.6,
        rvol_1m=5.0,
        rvol_3m=5.0,
        rvol_5m=3.0,
        rvol_15m=3.0,
        trade_rate_mult=4.0,
        range_expansion=2.0,
        window_high=100.0,
        window_low=98.0,
        quote_volume_1m=250_000.0,
        trades_1m=900.0,
        quote_volume_24h=18_500_000.0,
        change_24h_pct=-6.0,
        last_meaningful_ts=T0,
        warming_up=False,
    )
    base.update(overrides)
    return WindowMetrics(**base)  # type: ignore[arg-type]


def level(price: float, kind: str = "swing_low", touches: int = 1) -> StructuralLevel:
    return StructuralLevel(
        price=price,
        kind=kind,  # type: ignore[arg-type]
        timeframe="5M",
        time=int(T0),
        touches=touches,
    )


def maps(*levels: StructuralLevel) -> tuple[StructureMap, ...]:
    lows = tuple(item for item in levels if "low" in item.kind)
    highs = tuple(item for item in levels if "high" in item.kind)
    return (
        StructureMap(
            timeframe="5M",
            trend="downtrend",
            event=None,
            event_label=None,
            event_time=int(T0),
            highs=highs,
            lows=lows,
            last_close=98.0,
            bars=120,
            computed_at=T0,
        ),
    )


BEARISH_CONTEXT = MarketContext(
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
            change_pct=-3.0,
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


def tracker(now: float = T0, **overrides: object) -> SymbolTracker:
    """A live bearish tracker with context attached."""
    base = advance_tracker(None, metrics(ts=now), now, SCALP.events)
    assert base is not None
    return replace(base, context=BEARISH_CONTEXT, alignment=ALIGNED, **overrides)  # type: ignore[arg-type]


def candidate(now: float = T0) -> Candidate:
    signal = detect_momentum(metrics(ts=now), SCALP.flow)
    assert signal is not None
    return open_candidate(metrics(ts=now), signal)


def advance(
    previous: Situation | None,
    *,
    now: float,
    price: float = 98.0,
    pullback_extreme: float | None = None,
    tracker_state: SymbolTracker | None = None,
    profile=SCALP,
    **kwargs: object,
) -> Situation:
    base: dict[str, object] = dict(
        volume_ratio=0.7,
        opposing_move_pct=0.0,
        directional_move_pct=0.0,
        directional_rvol=1.0,
        micro_choch=False,
        maps=maps(level(94.0, kind="equal_lows", touches=3)),
    )
    base.update(kwargs)
    return advance_situation(
        previous,
        tracker_state if tracker_state is not None else tracker(now),
        candidate(),
        price=price,
        pullback_extreme=pullback_extreme if pullback_extreme is not None else price,
        now=now,
        profile=profile,
        **base,  # type: ignore[arg-type]
    )


# ── lifecycle ────────────────────────────────────────────────────────────────


def test_a_fresh_event_opens_as_new() -> None:
    situation = advance(None, now=T0)
    assert situation.state == "NEW"
    assert situation.direction == "bearish"
    assert situation.first_seen == T0


def test_a_material_retracement_moves_it_to_pullback() -> None:
    opened = advance(None, now=T0)
    dwell = T0 + SCALP.situation.min_state_seconds + 1
    # Impulse ran 100 → 98; price back at 98.8 is 40% of the leg.
    situation = advance(opened, now=dwell, price=98.8, pullback_extreme=98.8)
    assert situation.state == "PULLBACK"
    assert situation.pullback is not None
    assert situation.pullback.retrace_frac == pytest.approx(0.40)
    assert situation.pullback_started_at == dwell


def test_the_state_does_not_move_inside_the_dwell_window() -> None:
    """A couple of eventful seconds may advance the situation once, not twice —
    this is what stops sections strobing."""
    opened = advance(None, now=T0)
    early = advance(opened, now=T0 + 2, price=98.8, pullback_extreme=98.8)
    assert early.state == "NEW"


def test_evidence_promotes_a_pullback_to_completion() -> None:
    now = T0
    situation = advance(None, now=now)
    for _ in range(2):
        now += SCALP.situation.min_state_seconds + 1
        situation = advance(
            situation,
            now=now,
            price=98.8,
            pullback_extreme=98.8,
            volume_ratio=0.6,
            micro_choch=True,
            directional_move_pct=0.4,
            directional_rvol=2.0,
        )
    assert situation.completion is not None
    assert situation.completion.state == "LIKELY"
    assert situation.state == "PULLBACK_COMPLETION"


def test_completion_does_not_walk_back_on_one_quiet_tick() -> None:
    """Hysteresis: the evidence has to genuinely collapse, not merely dip."""
    now = T0
    situation = advance(None, now=now)
    for _ in range(2):
        now += SCALP.situation.min_state_seconds + 1
        situation = advance(
            situation,
            now=now,
            price=98.8,
            pullback_extreme=98.8,
            volume_ratio=0.6,
            micro_choch=True,
            directional_move_pct=0.4,
            directional_rvol=2.0,
        )
    assert situation.state == "PULLBACK_COMPLETION"

    now += SCALP.situation.min_state_seconds + 1
    # Every trigger goes away; only the quiet-tape evidence is left.
    dipped = advance(
        situation,
        now=now,
        price=98.8,
        pullback_extreme=98.8,
        volume_ratio=0.6,
        micro_choch=False,
        directional_move_pct=0.0,
        directional_rvol=1.0,
    )
    assert dipped.completion is not None
    assert dipped.completion.state == "DEVELOPING"
    assert dipped.state == "PULLBACK_COMPLETION"


def test_the_evidence_outlives_the_retracement_that_produced_it() -> None:
    """A completion card whose pullback has resolved must still show *why* it
    was promoted — otherwise the state is an assertion with nothing behind it."""
    now = T0
    situation = advance(None, now=now)
    for _ in range(2):
        now += SCALP.situation.min_state_seconds + 1
        situation = advance(
            situation,
            now=now,
            price=98.8,
            pullback_extreme=98.8,
            volume_ratio=0.6,
            micro_choch=True,
            directional_move_pct=0.4,
            directional_rvol=2.0,
        )
    assert situation.state == "PULLBACK_COMPLETION"

    # Price resumes: the retracement is no longer active, so the live reads
    # would be empty.
    now += SCALP.situation.min_state_seconds + 1
    resumed = advance(situation, now=now, price=98.0, pullback_extreme=98.0)
    assert resumed.state == "PULLBACK_COMPLETION"
    assert resumed.completion is not None
    assert resumed.completion.met_count >= SCALP.completion.likely_min
    assert resumed.pullback is not None


def test_a_broken_impulse_invalidates_immediately_without_waiting_for_dwell() -> None:
    opened = advance(None, now=T0)
    broken = advance(opened, now=T0 + 2, price=101.0, pullback_extreme=101.0)
    assert broken.pullback is not None
    assert broken.pullback.state == "BROKEN"
    assert broken.state == "INVALID"


def test_invalid_is_terminal() -> None:
    opened = advance(None, now=T0)
    broken = advance(opened, now=T0 + 2, price=101.0, pullback_extreme=101.0)
    later = advance(broken, now=T0 + 200, price=98.0)
    assert later.state == "INVALID"
    assert later.is_terminal is True


def test_a_situation_with_nothing_live_goes_stale() -> None:
    opened = advance(None, now=T0)
    cold = T0 + SCALP.events.event_ttl_seconds + SCALP.situation.stale_seconds + 10
    quiet = advance_tracker(
        tracker(T0),
        metrics(ts=cold, change_1m_pct=0.0, change_3m_pct=0.0, rvol_1m=1.0, rvol_3m=1.0,
                trade_rate_mult=1.0, range_expansion=1.0),
        cold,
        SCALP.events,
    )
    assert quiet is not None
    situation = advance(opened, now=cold, tracker_state=quiet)
    assert situation.state == "STALE"
    assert situation.worth_watching is False


# ── the funnel ───────────────────────────────────────────────────────────────


def test_a_surfaced_situation_says_why_it_passed() -> None:
    situation = advance(None, now=T0)
    assert situation.worth_watching is True
    assert "displacement+participation" in situation.reasons
    assert "tier_medium" in situation.reasons
    assert "structurally_relevant" in situation.reasons


def test_a_situation_with_no_structure_is_rejected() -> None:
    situation = advance(None, now=T0, maps=())
    assert situation.worth_watching is False
    assert "no_structure" in situation.reasons


def test_a_situation_with_no_context_is_rejected() -> None:
    """Unknown higher-timeframe context is not a licence to guess."""
    bare = replace(tracker(T0), context=None, alignment=Alignment(
        level="UNKNOWN",
        classification="unclassified",
        agreement=0.0,
        context_bias="unknown",
        event_direction=None,
    ))
    situation = advance(None, now=T0, tracker_state=bare)
    assert situation.worth_watching is False
    assert "context_unknown" in situation.reasons


def test_a_stale_event_is_rejected() -> None:
    old = tracker(T0)
    late = T0 + SCALP.situation.freshness_seconds + 60
    situation = advance(None, now=late, tracker_state=old)
    assert situation.worth_watching is False
    assert "event_stale" in situation.reasons


def test_a_completion_with_no_room_is_rejected() -> None:
    """R is a filter: a completion whose only destination is inside the stop
    does not reach the page."""
    now = T0
    situation = advance(None, now=now)
    for _ in range(2):
        now += SCALP.situation.min_state_seconds + 1
        situation = advance(
            situation,
            now=now,
            price=98.8,
            pullback_extreme=98.8,
            volume_ratio=0.6,
            micro_choch=True,
            directional_move_pct=0.4,
            directional_rvol=2.0,
            # The only level ahead is a few ticks away.
            maps=maps(level(98.4)),
        )
    assert situation.state == "PULLBACK_COMPLETION"
    assert situation.worth_watching is False
    assert "path_too_short" in situation.reasons or "no_structural_path" in situation.reasons


def test_surfacing_is_capped_and_can_be_empty() -> None:
    rejected = [
        replace(advance(None, now=T0), symbol=f"T{i}", worth_watching=False) for i in range(5)
    ]
    assert surfaced(rejected, SCALP) == []

    many = [
        replace(advance(None, now=T0), symbol=f"T{i:02d}", score=90.0 - i)
        for i in range(SCALP.situation.max_surfaced + 6)
    ]
    assert len(surfaced(many, SCALP)) == SCALP.situation.max_surfaced


# ── ranking ──────────────────────────────────────────────────────────────────


def test_further_along_the_lifecycle_ranks_higher() -> None:
    base = advance(None, now=T0)
    rows = [
        replace(base, symbol="NEWER", state="NEW"),
        replace(base, symbol="DEEP", state="PULLBACK_COMPLETION"),
        replace(base, symbol="MID", state="PULLBACK"),
    ]
    assert [s.symbol for s in rank_situations(rows)] == ["DEEP", "MID", "NEWER"]


def test_ranking_does_not_churn_on_sub_bucket_score_noise() -> None:
    base = advance(None, now=T0)
    before = [
        replace(base, symbol="AAA", score=71.0, first_seen=T0),
        replace(base, symbol="BBB", score=69.5, first_seen=T0 + 5),
    ]
    after = [
        replace(base, symbol="AAA", score=70.2, first_seen=T0),
        replace(base, symbol="BBB", score=69.9, first_seen=T0 + 5),
    ]
    assert [s.symbol for s in rank_situations(before)] == ["AAA", "BBB"]
    assert [s.symbol for s in rank_situations(after)] == ["AAA", "BBB"]


# ── modes ────────────────────────────────────────────────────────────────────


def test_the_two_modes_read_different_windows() -> None:
    assert (SCALP.events.fast_window, SCALP.events.primary_window) == ("1m", "3m")
    assert (INTRADAY.events.fast_window, INTRADAY.events.primary_window) == ("5m", "15m")
    assert SCALP.flow.fast_window == "1m"
    assert INTRADAY.flow.fast_window == "5m"


def test_scalp_ignores_the_4h_regime_and_intraday_leads_with_it() -> None:
    assert SCALP.context.weight_4h == 0.0
    assert SCALP.context.weight_1h > SCALP.context.weight_15m
    assert INTRADAY.context.weight_4h > INTRADAY.context.weight_1h


def test_intraday_demands_a_larger_move_than_scalp() -> None:
    assert INTRADAY.events.displacement_fire_pct > SCALP.events.displacement_fire_pct
    assert INTRADAY.situation.freshness_seconds > SCALP.situation.freshness_seconds
    assert INTRADAY.events.event_ttl_seconds > SCALP.events.event_ttl_seconds


def test_scalp_demands_a_more_asymmetric_path_than_intraday() -> None:
    """A scalp with a 2R structure is not worth the spread; an intraday move
    has room to be less extreme."""
    assert SCALP.path.min_rr > INTRADAY.path.min_rr


def test_an_unknown_mode_degrades_to_scalp() -> None:
    assert profile_for("nonsense").mode == "SCALP"
    assert profile_for("intraday").mode == "INTRADAY"
    assert set(MODES) == {"SCALP", "INTRADAY"}


def test_the_same_tape_is_a_different_situation_at_each_horizon() -> None:
    """-2% over 3m on 5x volume is a scalp event; for intraday it is barely a
    ripple on the 15m window."""
    scalp_tracker = advance_tracker(None, metrics(), T0, SCALP.events)
    intraday_tracker = advance_tracker(
        None,
        metrics(change_15m_pct=-0.4, rvol_15m=1.1, trade_rate_mult=1.2, range_expansion=1.0),
        T0,
        INTRADAY.events,
    )
    assert scalp_tracker is not None
    assert intraday_tracker is None


# ── journal ──────────────────────────────────────────────────────────────────


def pullback_situation(now: float = T0) -> Situation:
    opened = advance(None, now=now)
    return advance(
        opened,
        now=now + SCALP.situation.min_state_seconds + 1,
        price=98.8,
        pullback_extreme=98.8,
    )


def test_only_developing_situations_are_recorded() -> None:
    journal = SituationJournal()
    assert journal.observe(advance(None, now=T0), 98.0, T0) is None
    assert journal.observe(pullback_situation(), 98.8, T0 + 30) is not None


def test_a_record_pins_the_context_and_path_it_was_opened_with() -> None:
    journal = SituationJournal()
    situation = pullback_situation()
    entry = journal.observe(situation, 98.8, T0 + 30)
    assert entry is not None
    assert entry.direction == "bearish"
    assert entry.context_bias == "bearish"
    assert entry.trigger_type != ""
    assert entry.entry is not None and entry.target is not None
    assert entry.outcome == "OPEN"


def test_excursions_are_tracked_in_the_direction_of_the_thesis() -> None:
    journal = SituationJournal()
    situation = pullback_situation()
    journal.observe(situation, 98.8, T0 + 30)
    journal.observe(situation, 98.0, T0 + 40)  # favourable for a bearish thesis
    entry = journal.observe(situation, 98.9, T0 + 50)
    assert entry is not None
    assert entry.mfe_pct > 0
    assert entry.mae_pct < 0


def test_reaching_the_target_settles_the_record() -> None:
    journal = SituationJournal()
    situation = pullback_situation()
    journal.observe(situation, 98.8, T0 + 30)
    entry = journal.observe(situation, 93.0, T0 + 90)
    assert entry is not None
    assert entry.outcome == "TARGET"
    assert entry.closed_at == T0 + 90
    assert entry.is_open is False


def test_losing_the_invalidation_settles_the_other_way() -> None:
    journal = SituationJournal()
    situation = pullback_situation()
    opened = journal.observe(situation, 98.8, T0 + 30)
    assert opened is not None and opened.invalidation is not None
    entry = journal.observe(situation, opened.invalidation + 0.5, T0 + 90)
    assert entry is not None
    assert entry.outcome == "INVALIDATED"


def test_a_settled_record_is_not_reopened_by_later_ticks() -> None:
    journal = SituationJournal()
    situation = pullback_situation()
    journal.observe(situation, 98.8, T0 + 30)
    journal.observe(situation, 93.0, T0 + 90)
    entry = journal.observe(situation, 98.8, T0 + 120)
    assert entry is not None
    assert entry.outcome == "TARGET"


def test_the_journal_is_bounded() -> None:
    journal = SituationJournal(max_entries=3)
    for index in range(8):
        situation = replace(pullback_situation(), symbol=f"T{index}", first_seen=T0 + index)
        journal.observe(situation, 98.8, T0 + 30)
    assert len(journal.entries) == 3


def test_journal_stats_summarize_without_claiming_performance() -> None:
    journal = SituationJournal()
    situation = pullback_situation()
    journal.observe(situation, 98.8, T0 + 30)
    stats = journal.stats("SCALP")
    assert stats["recorded"] == 1.0
    assert stats["open"] == 1.0
    assert "avg_rr" in stats


def test_recording_is_deterministic() -> None:
    """Same inputs, same journal — the property every later measurement of the
    detector depends on."""
    first, second = SituationJournal(), SituationJournal()
    situation = pullback_situation()
    a = first.observe(situation, 98.8, T0 + 30)
    b = second.observe(situation, 98.8, T0 + 30)
    assert a == b


def test_a_headline_event_travels_onto_the_situation() -> None:
    situation = advance(None, now=T0)
    assert isinstance(situation.headline, MarketEvent)
    assert situation.headline.type in {"VOLUME_ANOMALY", "PRICE_DISPLACEMENT"}


# ── selectivity: observations are not situations ─────────────────────────────


def unqualified_tracker(now: float = T0) -> SymbolTracker:
    """A symbol with one lone observation: a volume spike nobody traded."""
    lone = metrics(
        ts=now,
        change_1m_pct=0.05,
        change_3m_pct=0.10,
        trade_rate_mult=1.1,
        range_expansion=1.0,
    )
    base = advance_tracker(None, lone, now, SCALP.events)
    assert base is not None
    return replace(base, context=BEARISH_CONTEXT, alignment=ALIGNED)


def test_a_lone_observation_is_never_surfaced() -> None:
    situation = advance(None, now=T0, tracker_state=unqualified_tracker())
    assert situation.worth_watching is False
    assert "unqualified" in situation.reasons


def test_a_lone_observation_never_reaches_developing() -> None:
    """However long it survives. Age is not evidence."""
    now = T0
    situation = advance(None, now=now, tracker_state=unqualified_tracker(now))
    for _ in range(3):
        now += SCALP.situation.min_state_seconds + 1
        situation = advance(situation, now=now, tracker_state=unqualified_tracker(T0))
    assert situation.state in ("NEW", "STALE")
    assert situation.state != "DEVELOPING"


def test_weak_evidence_qualifies_but_does_not_surface() -> None:
    """An anomaly with only a volatility response is a real relationship and a
    thin one — it exists in the funnel, it does not reach the page."""
    weak = metrics(change_3m_pct=0.1, trade_rate_mult=1.0, range_expansion=4.0)
    base = advance_tracker(None, weak, T0, SCALP.events)
    assert base is not None
    assert base.qualification.tier == "LOW"
    situation = advance(
        None, now=T0, tracker_state=replace(base, context=BEARISH_CONTEXT, alignment=ALIGNED)
    )
    assert situation.worth_watching is False
    assert "weak_evidence" in situation.reasons


def test_an_ageing_card_with_nothing_new_goes_stale() -> None:
    """Ten minutes without a fresh event is not "developing", it is history."""
    situation = advance(None, now=T0)
    aged = T0 + SCALP.situation.developing_max_age_seconds + 30
    situation = advance(situation, now=aged, tracker_state=tracker(T0))
    assert situation.state == "STALE"
    assert situation.worth_watching is False


def test_a_structural_event_keeps_an_ageing_card_alive() -> None:
    """…unless something structural is actively extending the story."""
    situation = advance(None, now=T0)
    aged = T0 + SCALP.situation.developing_max_age_seconds + 30
    extended = advance_tracker(
        tracker(T0),
        metrics(ts=aged),
        aged,
        SCALP.events,
        structural=[
            MarketEvent(
                symbol="TST",
                type="CHOCH",
                direction="bearish",
                ts=aged - 10,
                last_seen_ts=aged - 10,
                magnitude=1.0,
                peak_magnitude=1.0,
                unit="1m",
                score=SCALP.events.choch_score,
                peak_score=SCALP.events.choch_score,
            )
        ],
    )
    assert extended is not None
    situation = advance(situation, now=aged, tracker_state=extended)
    assert situation.state != "STALE"


def test_scalp_decays_faster_than_intraday() -> None:
    assert SCALP.situation.freshness_seconds < INTRADAY.situation.freshness_seconds
    assert (
        SCALP.situation.developing_max_age_seconds
        < INTRADAY.situation.developing_max_age_seconds
    )


def test_both_modes_demand_at_least_medium_evidence() -> None:
    assert SCALP.situation.min_tier == "MEDIUM"
    assert INTRADAY.situation.min_tier == "MEDIUM"
