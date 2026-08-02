"""Every derived derivatives metric, exercised as a pure function.

No DB and no network here on purpose: `service.py` is deliberately I/O-free so
that the classification rules can be pinned by fixtures instead of by whatever
Binance happened to print. The API and worker have their own files.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.derivatives.constants import SNAPSHOT_INTERVAL_S
from app.derivatives.service import (
    SnapshotPoint,
    _funding_label,
    _pct,
    _price_acceleration,
    _scale_0_100,
    _weighted,
    build_intelligence,
    buyer_aggression,
    classify_oi_expansion,
    classify_regime,
    crowding_band,
    crowding_score,
    derive,
    funding_trend,
    history_series,
    momentum_score,
    pct_delta,
    pick_at,
    squeeze_scores,
)

BASE = datetime(2026, 8, 2, 12, 0, tzinfo=UTC)


def at(minutes_ago: float, **fields: float | None) -> SnapshotPoint:
    return SnapshotPoint(timestamp=BASE - timedelta(minutes=minutes_ago), **fields)  # type: ignore[arg-type]


def ascending(*points: SnapshotPoint) -> list[SnapshotPoint]:
    return sorted(points, key=lambda p: p.timestamp)


# --- series access -------------------------------------------------------


def test_pick_at_returns_nearest_sample_within_tolerance() -> None:
    series = ascending(at(0, open_interest=110), at(60, open_interest=100))
    target = (BASE - timedelta(minutes=60)).timestamp()
    picked = pick_at(series, target, 600, lambda p: p.open_interest)
    assert picked is not None
    assert picked.open_interest == 100


def test_pick_at_refuses_a_sample_outside_tolerance() -> None:
    """A three-hour-old table must not answer a 24h question."""
    series = ascending(at(0, open_interest=110), at(180, open_interest=100))
    target = (BASE - timedelta(hours=24)).timestamp()
    assert pick_at(series, target, 3600, lambda p: p.open_interest) is None


def test_pick_at_skips_points_missing_the_metric() -> None:
    series = ascending(at(0, open_interest=110), at(60, price=5), at(62, open_interest=100))
    target = (BASE - timedelta(minutes=60)).timestamp()
    picked = pick_at(series, target, 600, lambda p: p.open_interest)
    assert picked is not None and picked.open_interest == 100


# --- OI delta windows ----------------------------------------------------


def test_oi_delta_every_window() -> None:
    series = ascending(
        at(1440, open_interest=50),
        at(60, open_interest=100),
        at(15, open_interest=105),
        at(5, open_interest=110),
        at(0, open_interest=121),
    )
    assert pct_delta(series, lambda p: p.open_interest, 300) == pytest.approx(10.0)
    assert pct_delta(series, lambda p: p.open_interest, 900) == pytest.approx(15.238, abs=1e-3)
    assert pct_delta(series, lambda p: p.open_interest, 3600) == pytest.approx(21.0)
    assert pct_delta(series, lambda p: p.open_interest, 86400) == pytest.approx(142.0)


def test_delta_is_none_without_a_sample_at_the_window_start() -> None:
    series = ascending(at(0, open_interest=110), at(5, open_interest=100))
    assert pct_delta(series, lambda p: p.open_interest, 86400) is None


def test_delta_is_none_when_the_baseline_is_zero() -> None:
    series = ascending(at(0, open_interest=110), at(5, open_interest=0))
    assert pct_delta(series, lambda p: p.open_interest, 300) is None


def test_delta_is_none_with_a_single_sample() -> None:
    assert pct_delta([at(0, open_interest=110)], lambda p: p.open_interest, 300) is None


def test_delta_ignores_non_finite_values() -> None:
    series = ascending(at(0, open_interest=float("nan")), at(5, open_interest=100))
    assert pct_delta(series, lambda p: p.open_interest, 300) is None


def test_delta_anchors_on_the_newest_sample_not_wall_clock() -> None:
    """A stale table reports a stale delta rather than a fabricated fresh one."""
    stale = ascending(
        SnapshotPoint(timestamp=BASE - timedelta(days=3), open_interest=100),
        SnapshotPoint(timestamp=BASE - timedelta(days=3, minutes=-5), open_interest=110),
    )
    assert pct_delta(stale, lambda p: p.open_interest, 300) == pytest.approx(10.0)


# --- buyer aggression ----------------------------------------------------


def test_buyer_aggression_ratio() -> None:
    assert buyer_aggression(at(0, taker_buy_volume=74, taker_sell_volume=26)) == pytest.approx(0.74)


def test_buyer_aggression_needs_both_legs() -> None:
    assert buyer_aggression(at(0, taker_buy_volume=74)) is None
    assert buyer_aggression(at(0, taker_sell_volume=26)) is None


def test_buyer_aggression_is_none_on_a_dead_bar() -> None:
    assert buyer_aggression(at(0, taker_buy_volume=0, taker_sell_volume=0)) is None


# --- OI expansion --------------------------------------------------------


def test_expansion_bullish_expansion() -> None:
    assert classify_oi_expansion(3.0, 8.0) == "bullish_expansion"


def test_expansion_short_covering() -> None:
    assert classify_oi_expansion(3.0, -8.0) == "short_covering"


def test_expansion_bearish_expansion() -> None:
    assert classify_oi_expansion(-3.0, 8.0) == "bearish_expansion"


def test_expansion_long_capitulation() -> None:
    assert classify_oi_expansion(-3.0, -8.0) == "long_capitulation"


def test_expansion_neutral_when_flat_or_missing() -> None:
    assert classify_oi_expansion(0.01, 8.0) == "neutral"
    assert classify_oi_expansion(3.0, 0.01) == "neutral"
    assert classify_oi_expansion(None, 8.0) == "neutral"
    assert classify_oi_expansion(3.0, None) == "neutral"


# --- funding trend -------------------------------------------------------


def test_funding_trend_current_deltas_and_percentile() -> None:
    series = ascending(
        at(1200, funding_rate=0.0001),
        at(60, funding_rate=0.0002),
        at(15, funding_rate=0.0003),
        at(0, funding_rate=0.0005),
    )
    trend = funding_trend(series)
    assert trend.current == pytest.approx(0.0005)
    assert trend.delta_15m == pytest.approx(0.0002)
    assert trend.delta_1h == pytest.approx(0.0003)
    # Highest of the four samples inside 24h.
    assert trend.percentile_24h == pytest.approx(100.0)


def test_funding_percentile_ranks_a_low_current_rate_low() -> None:
    series = ascending(
        at(60, funding_rate=0.0009),
        at(30, funding_rate=0.0007),
        at(0, funding_rate=0.0001),
    )
    assert funding_trend(series).percentile_24h == pytest.approx(100 / 3)


def test_funding_trend_empty_and_single_sample() -> None:
    empty = funding_trend([])
    assert (empty.current, empty.delta_15m, empty.percentile_24h) == (None, None, None)

    single = funding_trend([at(0, funding_rate=0.0002)])
    assert single.current == pytest.approx(0.0002)
    assert single.delta_15m is None
    assert single.percentile_24h is None


def test_funding_trend_ignores_rows_without_a_rate() -> None:
    series = ascending(at(0, open_interest=10), at(5, open_interest=9))
    assert funding_trend(series).current is None


# --- crowding ------------------------------------------------------------


def test_crowding_score_weights_its_three_components() -> None:
    # funding 0.00025 → 75 (w .40) · L/S 1.0 → 50 (w .30) · top 1.0/1.0 → 50 (w .30)
    point = at(
        0,
        funding_rate=0.00025,
        long_short_ratio=1.0,
        top_trader_accounts_ratio=1.0,
        top_trader_positions_ratio=1.0,
    )
    assert crowding_score(point) == pytest.approx(0.4 * 75 + 0.3 * 50 + 0.3 * 50)


def test_crowding_renormalises_over_available_components() -> None:
    """Funding alone must score as funding alone, not as funding diluted by
    two components that never arrived."""
    assert crowding_score(at(0, funding_rate=0.00025)) == pytest.approx(75.0)


def test_crowding_is_none_without_any_component() -> None:
    assert crowding_score(at(0, price=100)) is None


def test_crowding_uses_the_log_of_the_ratio() -> None:
    """2.0 and 0.5 are equally lopsided, mirrored around 50."""
    long_heavy = crowding_score(at(0, long_short_ratio=2.0))
    short_heavy = crowding_score(at(0, long_short_ratio=0.5))
    assert long_heavy is not None and short_heavy is not None
    assert long_heavy + short_heavy == pytest.approx(100.0)


def test_crowding_rejects_a_nonpositive_ratio() -> None:
    assert crowding_score(at(0, long_short_ratio=0.0)) is None


def test_crowding_bands() -> None:
    assert crowding_band(12.0) == "bearish_crowded"
    assert crowding_band(29.9) == "bearish_crowded"
    assert crowding_band(30.0) == "balanced"
    assert crowding_band(50.0) == "balanced"
    assert crowding_band(70.0) == "balanced"
    assert crowding_band(70.1) == "bullish_crowded"
    assert crowding_band(None) == "unknown"


# --- momentum ------------------------------------------------------------


def test_momentum_weighting_is_exact() -> None:
    score = momentum_score(
        "bullish_expansion",  # 100 x .40
        0.80,  # 80 x .35
        0.00025,  # 75 x .15
        0.0005,  # 75 x .10
        has_expansion_evidence=True,
    )
    assert score == pytest.approx(0.4 * 100 + 0.35 * 80 + 0.15 * 75 + 0.10 * 75)


def test_momentum_drops_expansion_without_evidence() -> None:
    """A "neutral" class that only exists because a delta was missing must not
    be scored as a confident 50."""
    score = momentum_score("neutral", 0.80, None, None, has_expansion_evidence=False)
    assert score == pytest.approx(80.0)


def test_momentum_scores_a_bearish_expansion_low() -> None:
    score = momentum_score("bearish_expansion", 0.20, -0.0005, -0.001, has_expansion_evidence=True)
    assert score == pytest.approx(0.35 * 20)


def test_momentum_is_none_without_any_component() -> None:
    assert momentum_score("neutral", None, None, None, has_expansion_evidence=False) is None


def test_momentum_clamps_extreme_funding_and_basis() -> None:
    score = momentum_score("bullish_expansion", 1.0, 5.0, 5.0, has_expansion_evidence=True)
    assert score == pytest.approx(100.0)


# --- squeeze -------------------------------------------------------------


def test_squeeze_flags_the_crowded_long_side() -> None:
    squeeze = squeeze_scores(crowding=85.0, oi_delta_pct=4.0, price_acceleration_pct=-1.5)
    assert squeeze.long > squeeze.short
    # Both sides carry a number: the tape is mildly awkward for shorts and
    # much worse for longs, and collapsing that to one figure loses half of it.
    assert squeeze.short > 0.0
    assert 0 <= squeeze.long <= 100


def test_squeeze_flags_the_crowded_short_side() -> None:
    squeeze = squeeze_scores(crowding=15.0, oi_delta_pct=4.0, price_acceleration_pct=1.5)
    assert squeeze.short > squeeze.long
    assert squeeze.long > 0.0


def test_squeeze_is_symmetric_at_a_balanced_book() -> None:
    squeeze = squeeze_scores(crowding=50.0, oi_delta_pct=4.0, price_acceleration_pct=0.0)
    assert squeeze.long == squeeze.short


def test_squeeze_reproduces_the_spec_shape() -> None:
    """A long-crowded book with fuel and an adverse move reads roughly
    "Long 73 · Short 19" — two independent numbers, not a split of one."""
    squeeze = squeeze_scores(crowding=73.0, oi_delta_pct=5.0, price_acceleration_pct=-2.0)
    assert squeeze.long == pytest.approx(73.0)
    assert squeeze.short == pytest.approx(18.9)


@pytest.mark.parametrize("crowding", [0.0, 15.0, 50.0, 73.0, 100.0])
@pytest.mark.parametrize("oi", [None, -5.0, 0.0, 5.0, 50.0])
@pytest.mark.parametrize("accel", [None, -5.0, 0.0, 5.0])
def test_squeeze_sum_never_exceeds_100(
    crowding: float, oi: float | None, accel: float | None
) -> None:
    """The invariant that makes the pair readable as a comparison. It holds by
    construction, which is why nothing is renormalised after the fact."""
    squeeze = squeeze_scores(crowding, oi, accel)
    assert squeeze.long >= 0 and squeeze.short >= 0
    assert squeeze.long + squeeze.short <= 100.0 + 1e-9


def test_squeeze_clamps_a_crowding_score_outside_the_scale() -> None:
    assert squeeze_scores(140.0, None, None).short == 0.0
    assert squeeze_scores(-40.0, None, None).long == 0.0


def test_squeeze_label_when_both_sides_read_the_same() -> None:
    intel = build_intelligence(
        regime="neutral",
        expansion="neutral",
        oi_delta_pct=None,
        price_delta_pct=None,
        aggression=None,
        funding=funding_trend([]),
        crowding=50.0,
        squeeze=squeeze_scores(50.0, 0.0, 0.0),
        sample_count=40,
    )
    assert intel.squeeze_label == "Kedua sisi sama rentan"


def test_squeeze_is_zero_without_a_crowding_read() -> None:
    squeeze = squeeze_scores(crowding=None, oi_delta_pct=4.0, price_acceleration_pct=-1.5)
    assert (squeeze.long, squeeze.short) == (0.0, 0.0)


def test_squeeze_rises_with_oi_fuel_and_adverse_acceleration() -> None:
    quiet = squeeze_scores(crowding=85.0, oi_delta_pct=None, price_acceleration_pct=None)
    fuelled = squeeze_scores(crowding=85.0, oi_delta_pct=5.0, price_acceleration_pct=-2.0)
    assert fuelled.long > quiet.long


# --- regime --------------------------------------------------------------


def test_regime_short_squeeze() -> None:
    assert (
        classify_regime(
            expansion="short_covering",
            price_delta_pct=4.0,
            oi_delta_pct=-6.0,
            crowding=25.0,
            momentum=60.0,
        )
        == "short_squeeze"
    )


def test_regime_long_squeeze() -> None:
    assert (
        classify_regime(
            expansion="long_capitulation",
            price_delta_pct=-4.0,
            oi_delta_pct=-6.0,
            crowding=75.0,
            momentum=40.0,
        )
        == "long_squeeze"
    )


def test_regime_distribution() -> None:
    assert (
        classify_regime(
            expansion="neutral",
            price_delta_pct=0.2,
            oi_delta_pct=6.0,
            crowding=85.0,
            momentum=55.0,
        )
        == "distribution"
    )


def test_regime_accumulation() -> None:
    assert (
        classify_regime(
            expansion="neutral",
            price_delta_pct=-0.2,
            oi_delta_pct=6.0,
            crowding=12.0,
            momentum=45.0,
        )
        == "accumulation"
    )


def test_regime_strong_bull_trend() -> None:
    assert (
        classify_regime(
            expansion="bullish_expansion",
            price_delta_pct=3.0,
            oi_delta_pct=8.0,
            crowding=55.0,
            momentum=82.0,
        )
        == "strong_bull_trend"
    )


def test_regime_weak_bull_trend() -> None:
    assert (
        classify_regime(
            expansion="bullish_expansion",
            price_delta_pct=3.0,
            oi_delta_pct=2.0,
            crowding=55.0,
            momentum=58.0,
        )
        == "weak_bull_trend"
    )


def test_regime_strong_bear_trend() -> None:
    assert (
        classify_regime(
            expansion="bearish_expansion",
            price_delta_pct=-3.0,
            oi_delta_pct=8.0,
            crowding=45.0,
            momentum=18.0,
        )
        == "strong_bear_trend"
    )


def test_regime_weak_bear_trend() -> None:
    assert (
        classify_regime(
            expansion="bearish_expansion",
            price_delta_pct=-3.0,
            oi_delta_pct=2.0,
            crowding=45.0,
            momentum=42.0,
        )
        == "weak_bear_trend"
    )


def test_regime_neutral_when_no_rule_fires() -> None:
    assert (
        classify_regime(
            expansion="neutral",
            price_delta_pct=0.1,
            oi_delta_pct=0.1,
            crowding=50.0,
            momentum=50.0,
        )
        == "neutral"
    )


def test_regime_neutral_without_data() -> None:
    assert (
        classify_regime(
            expansion="neutral",
            price_delta_pct=None,
            oi_delta_pct=None,
            crowding=None,
            momentum=None,
        )
        == "neutral"
    )


def test_regime_squeeze_rules_outrank_trend_rules() -> None:
    """A 4% rally on collapsing OI is a short squeeze, not a bull trend, even
    when momentum reads high."""
    assert (
        classify_regime(
            expansion="short_covering",
            price_delta_pct=4.0,
            oi_delta_pct=-6.0,
            crowding=20.0,
            momentum=95.0,
        )
        == "short_squeeze"
    )


def test_regime_flat_price_with_flat_oi_is_not_accumulation() -> None:
    assert (
        classify_regime(
            expansion="neutral",
            price_delta_pct=0.2,
            oi_delta_pct=0.1,
            crowding=12.0,
            momentum=50.0,
        )
        == "neutral"
    )


# --- intelligence templates ---------------------------------------------


def test_intelligence_narrates_a_bullish_expansion_in_indonesian() -> None:
    intel = build_intelligence(
        regime="strong_bull_trend",
        expansion="bullish_expansion",
        oi_delta_pct=8.0,
        price_delta_pct=3.0,
        aggression=0.72,
        funding=funding_trend([at(0, funding_rate=0.0)]),
        crowding=55.0,
        squeeze=squeeze_scores(55.0, 8.0, 0.5),
        sample_count=40,
    )
    assert "OI +8.0%" in intel.summary
    assert "harga +3.0%" in intel.summary
    assert "Uang baru masuk ke sisi long." in intel.summary
    assert "Buyer aggression di atas 72%." in intel.summary
    assert "Funding netral." in intel.summary
    assert "Probabilitas kelanjutan tren naik tinggi." in intel.summary
    assert intel.regime_label == "Tren Naik Kuat"
    assert intel.expansion_label == "Bullish Expansion"
    assert intel.crowding_label == "Seimbang"


def test_intelligence_calls_out_seller_dominance_and_crowding() -> None:
    intel = build_intelligence(
        regime="long_squeeze",
        expansion="long_capitulation",
        oi_delta_pct=-6.0,
        price_delta_pct=-4.0,
        aggression=0.28,
        funding=funding_trend([at(0, funding_rate=0.0009)]),
        crowding=88.0,
        squeeze=squeeze_scores(88.0, 0.0, -2.0),
        sample_count=40,
    )
    assert "Seller mendominasi" in intel.summary
    assert "risiko long squeeze naik" in intel.summary
    assert intel.regime_label == "Long Squeeze"
    assert intel.crowding_label == "Long padat"
    assert intel.funding_label.startswith("Sangat positif")


def test_intelligence_flags_a_short_crowded_book() -> None:
    intel = build_intelligence(
        regime="accumulation",
        expansion="neutral",
        oi_delta_pct=6.0,
        price_delta_pct=0.2,
        aggression=0.5,
        funding=funding_trend([at(0, funding_rate=-0.0009)]),
        crowding=12.0,
        squeeze=squeeze_scores(12.0, 6.0, 1.0),
        sample_count=40,
    )
    assert "risiko short squeeze naik" in intel.summary
    assert intel.crowding_label == "Short padat"
    assert intel.funding_label.startswith("Sangat negatif")
    assert "Long lebih rentan" not in intel.squeeze_label


def test_intelligence_admits_a_thin_sample() -> None:
    intel = build_intelligence(
        regime="neutral",
        expansion="neutral",
        oi_delta_pct=None,
        price_delta_pct=None,
        aggression=None,
        funding=funding_trend([]),
        crowding=None,
        squeeze=squeeze_scores(None, None, None),
        sample_count=2,
    )
    assert "sampel masih sedikit" in intel.summary
    assert intel.crowding_label == "Belum cukup data"
    assert intel.oi_label == "Belum ada data"
    assert intel.aggression_label == "Belum ada data"
    assert intel.funding_label == "Belum ada data"
    assert intel.squeeze_label == "Tidak ada sisi yang padat"


def test_intelligence_labels_oi_direction() -> None:
    def oi_label_for(delta: float) -> str:
        return build_intelligence(
            regime="neutral",
            expansion="neutral",
            oi_delta_pct=delta,
            price_delta_pct=0.0,
            aggression=0.5,
            funding=funding_trend([]),
            crowding=50.0,
            squeeze=squeeze_scores(50.0, delta, 0.0),
            sample_count=40,
        ).oi_label

    assert oi_label_for(5.0).startswith("Menebal")
    assert oi_label_for(-5.0).startswith("Menipis")
    assert oi_label_for(0.2).startswith("Datar")


def test_intelligence_aggression_bands() -> None:
    def label_for(aggression: float) -> str:
        return build_intelligence(
            regime="neutral",
            expansion="neutral",
            oi_delta_pct=None,
            price_delta_pct=None,
            aggression=aggression,
            funding=funding_trend([]),
            crowding=None,
            squeeze=squeeze_scores(None, None, None),
            sample_count=40,
        ).aggression_label

    assert label_for(0.80).endswith("Buyer kuat")
    assert label_for(0.50).endswith("Seimbang")
    assert label_for(0.20).endswith("Seller kuat")


def _funding_label_for(rates: list[float]) -> str:
    """`rates` oldest-first; the last one is the current rate."""
    series = [
        SnapshotPoint(
            timestamp=BASE - timedelta(minutes=5 * (len(rates) - 1 - index)),
            funding_rate=rate,
        )
        for index, rate in enumerate(rates)
    ]
    return build_intelligence(
        regime="neutral",
        expansion="neutral",
        oi_delta_pct=None,
        price_delta_pct=None,
        aggression=None,
        funding=funding_trend(series),
        crowding=None,
        squeeze=squeeze_scores(None, None, None),
        sample_count=40,
    ).funding_label


def test_intelligence_funding_percentile_suffixes() -> None:
    # Ten samples so the percentile can actually reach the 10 / 90 edges.
    climbing = [0.00001 * step for step in range(1, 10)] + [0.0002]
    assert "tertinggi 24 jam" in _funding_label_for(climbing)

    falling = [0.0002] + [0.00009 - 0.00001 * step for step in range(9)]
    assert "terendah 24 jam" in _funding_label_for(falling)


def test_intelligence_squeeze_label_prefers_the_exposed_side() -> None:
    long_side = build_intelligence(
        regime="neutral",
        expansion="neutral",
        oi_delta_pct=None,
        price_delta_pct=None,
        aggression=None,
        funding=funding_trend([]),
        crowding=None,
        squeeze=squeeze_scores(90.0, 5.0, -2.0),
        sample_count=40,
    )
    assert long_side.squeeze_label.startswith("Long lebih rentan")

    short_side = build_intelligence(
        regime="neutral",
        expansion="neutral",
        oi_delta_pct=None,
        price_delta_pct=None,
        aggression=None,
        funding=funding_trend([]),
        crowding=None,
        squeeze=squeeze_scores(10.0, 5.0, 2.0),
        sample_count=40,
    )
    assert short_side.squeeze_label.startswith("Short lebih rentan")


# --- assembly ------------------------------------------------------------


def full_series() -> list[SnapshotPoint]:
    """A bullish-expansion tape: price and OI both climbing, buyers crossing
    the spread, mild positive funding."""
    points: list[SnapshotPoint] = []
    for index in range(13):  # 12 slots = 1 hour of 5-minute snapshots
        minutes_ago = 60 - index * 5
        points.append(
            SnapshotPoint(
                timestamp=BASE - timedelta(minutes=minutes_ago),
                price=100.0 + index * 0.25,
                open_interest=1000.0 + index * 8,
                open_interest_usd=(1000.0 + index * 8) * 100,
                funding_rate=0.00005 * (index + 1),
                long_short_ratio=1.2,
                top_trader_accounts_ratio=1.1,
                top_trader_positions_ratio=1.15,
                taker_buy_volume=74.0,
                taker_sell_volume=26.0,
                basis=0.5,
                premium=0.0004,
                oi_marketcap_ratio=0.021,
            )
        )
    return points


def test_derive_returns_every_section() -> None:
    result = derive("BTCUSDT", full_series())
    assert result is not None
    assert result.raw.symbol == "BTCUSDT"
    assert result.raw.price == pytest.approx(103.0)
    assert result.derived.oi_expansion == "bullish_expansion"
    assert result.derived.buyer_aggression == pytest.approx(0.74)
    assert result.derived.oi_delta["1h"] == pytest.approx(9.6)
    assert result.derived.price_delta["1h"] == pytest.approx(3.0)
    assert result.derived.sample_count == 13
    assert result.derived.history_span_s == pytest.approx(3600)
    assert result.scores.momentum is not None
    assert result.scores.crowding is not None
    assert result.regime in {"strong_bull_trend", "weak_bull_trend"}
    assert result.intelligence.summary


def test_derive_returns_none_on_an_empty_series() -> None:
    assert derive("BTCUSDT", []) is None


def test_derive_survives_a_snapshot_with_only_open_interest() -> None:
    """Exactly the shape the cold-start backfill writes."""
    series = ascending(at(5, open_interest=100), at(0, open_interest=110))
    result = derive("BTCUSDT", series)
    assert result is not None
    assert result.derived.oi_delta["5m"] == pytest.approx(10.0)
    assert result.derived.buyer_aggression is None
    assert result.scores.momentum is None
    assert result.scores.crowding is None
    assert result.regime == "neutral"


def test_derive_rounds_scores_to_one_decimal() -> None:
    result = derive("BTCUSDT", full_series())
    assert result is not None
    for value in (result.scores.momentum, result.scores.crowding):
        assert value is not None
        assert value == round(value, 1)


# --- sparkline series ----------------------------------------------------


def test_history_series_oi_over_one_hour() -> None:
    points = history_series(full_series(), "oi", "1h")
    assert len(points) == 13
    assert points[0].t < points[-1].t
    assert points[-1].v == pytest.approx(1096.0)


def test_history_series_trims_to_the_window() -> None:
    long_run = [
        SnapshotPoint(
            timestamp=BASE - timedelta(seconds=SNAPSHOT_INTERVAL_S * index),
            open_interest=1000.0 + index,
        )
        for index in range(60, -1, -1)
    ]
    assert len(history_series(long_run, "oi", "1h")) == 13
    assert len(history_series(long_run, "oi", "4h")) == 49
    assert len(history_series(long_run, "oi", "24h")) == 61
    assert len(history_series(long_run, "oi", "5m")) == 2


def test_history_series_funding_and_buyer_aggression() -> None:
    series = full_series()
    funding_points = history_series(series, "funding", "1h")
    aggression_points = history_series(series, "buyer_aggression", "1h")
    assert funding_points[-1].v == pytest.approx(0.00065)
    assert aggression_points[-1].v == pytest.approx(0.74)


def test_history_series_momentum_uses_only_past_points() -> None:
    points = history_series(full_series(), "momentum", "1h")
    # The first sample has no trailing delta, so it cannot score expansion and
    # is still emitted from its other components — but it must not borrow the
    # future to do it.
    assert points
    assert all(0.0 <= point.v <= 100.0 for point in points)
    assert points[-1].v > points[0].v


def test_history_series_skips_points_missing_the_metric() -> None:
    series = ascending(at(10, open_interest=100), at(5, price=1.0), at(0, open_interest=110))
    assert len(history_series(series, "oi", "1h")) == 2


def test_history_series_on_empty_input() -> None:
    assert history_series([], "oi", "1h") == []


# --- internal guards -----------------------------------------------------


def test_scale_falls_back_to_neutral_on_a_degenerate_bound() -> None:
    assert _scale_0_100(5.0, 0.0) == 50.0


def test_weighted_ignores_components_carrying_no_weight() -> None:
    assert _weighted({"a": 10.0, "unknown": 90.0}, {"a": 1.0}) == pytest.approx(10.0)
    assert _weighted({"a": 10.0}, {"a": 0.0}) is None


def test_price_acceleration_falls_back_to_raw_velocity() -> None:
    """With no hourly baseline, the recent leg IS the best estimate."""
    assert _price_acceleration({"15m": 1.5}) == pytest.approx(1.5)
    assert _price_acceleration({"15m": 1.5, "1h": 2.0}) == pytest.approx(1.0)
    assert _price_acceleration({"1h": 2.0}) is None


def test_pct_renders_a_missing_value_as_a_dash() -> None:
    assert _pct(None) == "-"
    assert _pct(3.0) == "+3.0%"
    assert _pct(-3.0) == "-3.0%"


def test_funding_label_covers_the_mild_bands() -> None:
    assert _funding_label(0.0002, None) == "Positif"
    assert _funding_label(-0.0002, None) == "Negatif"
    assert _funding_label(0.0, None) == "Netral"
    # A percentile in the middle adds no suffix.
    assert _funding_label(0.0002, 50.0) == "Positif"
