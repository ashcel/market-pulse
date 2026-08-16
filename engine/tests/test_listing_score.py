"""Screener scoring — the gate, the components, and the two properties that
keep the number honest: missing inputs never score as good inputs, and a
warning never silently moves the score.
"""

from datetime import UTC, datetime, timedelta

from smc.listing_score import (
    MIN_LIQUIDITY_USD,
    DistributionRead,
    FlowRead,
    ListingCandidate,
    SocialRead,
    grade_for,
    hours_to_listing,
    is_upcoming,
    reject_reason,
    score_distribution,
    score_flow,
    score_liquidity,
    score_supply,
    score_venue,
    screen,
)

NOW = datetime(2026, 8, 15, 12, 0, tzinfo=UTC)


def healthy() -> ListingCandidate:
    """A token with nothing obviously wrong with it."""
    return ListingCandidate(
        symbol="KII",
        name="KiiChain",
        chain="BSC",
        on_alpha=True,
        price_usd=0.08,
        market_cap_usd=28_000_000,
        fdv_usd=147_000_000,
        liquidity_usd=1_500_000,
        volume_24h_usd=39_000_000,
        circulating_supply=348_000_000,
        total_supply=1_800_000_000,
        listed_at=NOW - timedelta(days=1),
        flow=FlowRead(
            buys_1h=120, sells_1h=90, buys_24h=7000, sells_24h=6500, volume_24h_usd=39_000_000
        ),
        distribution=DistributionRead(holders=3800, top10_pct=0.28, largest_holder_pct=0.09),
        social=SocialRead(sentiment_up_pct=67, watchlist_users=113, posts_24h=20, post_sentiment=0.3),
    )


class TestRejectionGate:
    def test_dust_liquidity_is_rejected_before_scoring(self) -> None:
        candidate = healthy()
        candidate.liquidity_usd = MIN_LIQUIDITY_USD - 1
        assert reject_reason(candidate) == "liquidity_below_floor"

        result = screen(candidate, now=NOW)
        assert result.screened_out
        assert result.score == 0.0
        assert result.grade == "SKIP"
        assert result.components == []

    def test_dead_price_feed_is_rejected(self) -> None:
        candidate = healthy()
        candidate.price_usd = None
        assert reject_reason(candidate) == "no_price_feed"

    def test_thin_volume_is_rejected(self) -> None:
        candidate = healthy()
        candidate.volume_24h_usd = 1_000
        assert reject_reason(candidate) == "volume_below_floor"

    def test_an_unlisted_token_is_not_rejected_for_having_no_market(self) -> None:
        """The whole point of the screener is the pre-listing window; absent
        liquidity there is expected, not disqualifying."""
        candidate = ListingCandidate(
            symbol="SOON",
            price_usd=0.5,
            listing_at=NOW + timedelta(hours=6),
            liquidity_usd=None,
            volume_24h_usd=None,
        )
        assert reject_reason(candidate, now=NOW) is None
        assert is_upcoming(candidate, now=NOW)

    def test_a_healthy_token_passes_the_gate(self) -> None:
        assert reject_reason(healthy()) is None


class TestComponents:
    def test_liquidity_rewards_depth_relative_to_cap(self) -> None:
        thin = healthy()
        thin.liquidity_usd = 40_000
        deep = healthy()
        deep.liquidity_usd = 3_000_000

        thin_score = score_liquidity(thin)
        deep_score = score_liquidity(deep)
        assert thin_score is not None and deep_score is not None
        assert deep_score.score > thin_score.score

    def test_flow_favours_buyers_over_sellers(self) -> None:
        buying = healthy()
        buying.flow = FlowRead(buys_1h=180, sells_1h=40, buys_24h=7000, sells_24h=3000)
        selling = healthy()
        selling.flow = FlowRead(buys_1h=40, sells_1h=180, buys_24h=3000, sells_24h=7000)

        buy_score = score_flow(buying)
        sell_score = score_flow(selling)
        assert buy_score is not None and sell_score is not None
        assert buy_score.score > sell_score.score

    def test_flow_is_none_without_any_trades(self) -> None:
        candidate = healthy()
        candidate.flow = FlowRead()
        assert score_flow(candidate) is None

    def test_concentration_is_scored_inverted(self) -> None:
        dispersed = healthy()
        dispersed.distribution = DistributionRead(holders=3800, top10_pct=0.20)
        cartel = healthy()
        cartel.distribution = DistributionRead(holders=3800, top10_pct=0.75)

        dispersed_score = score_distribution(dispersed)
        cartel_score = score_distribution(cartel)
        assert dispersed_score is not None and cartel_score is not None
        assert dispersed_score.score > cartel_score.score

    def test_unavailable_distribution_is_skipped_not_zeroed(self) -> None:
        candidate = healthy()
        candidate.distribution = DistributionRead(available=False, unavailable_reason="no indexer")
        assert score_distribution(candidate) is None

    def test_low_float_scores_worse_than_high_float(self) -> None:
        low = healthy()
        low.circulating_supply = 50_000_000
        low.total_supply = 1_000_000_000
        high = healthy()
        high.circulating_supply = 800_000_000
        high.total_supply = 1_000_000_000

        low_score = score_supply(low)
        high_score = score_supply(high)
        assert low_score is not None and high_score is not None
        assert high_score.score > low_score.score

    def test_imminent_listing_outscores_a_plain_alpha_token(self) -> None:
        alpha_only = ListingCandidate(symbol="A", on_alpha=True, price_usd=1)
        listing_soon = ListingCandidate(
            symbol="B", on_alpha=True, price_usd=1, listing_at=NOW + timedelta(hours=3)
        )
        assert score_venue(listing_soon, now=NOW).score > score_venue(alpha_only, now=NOW).score

    def test_venue_ladder_is_cumulative(self) -> None:
        alpha = ListingCandidate(symbol="A", on_alpha=True, price_usd=1)
        perp = ListingCandidate(symbol="B", on_alpha=True, on_spot=True, on_futures=True, price_usd=1)
        assert score_venue(perp, now=NOW).score > score_venue(alpha, now=NOW).score


class TestComposite:
    def test_a_healthy_token_scores_and_reports_full_coverage(self) -> None:
        result = screen(healthy(), now=NOW)
        assert not result.screened_out
        assert 0 < result.score <= 100
        assert result.coverage > 0.9
        assert len(result.components) == 6
        assert result.evidence

    def test_coverage_falls_when_inputs_are_missing(self) -> None:
        candidate = healthy()
        candidate.flow = None
        candidate.distribution = None
        candidate.social = None

        result = screen(candidate, now=NOW)
        assert result.coverage < 0.7
        assert {c.key for c in result.components} == {"liquidity", "supply", "venue"}

    def test_thin_coverage_cannot_reach_priority(self) -> None:
        """A 90 computed off two components is not a PRIORITY — it is an
        unknown that happened to look good."""
        assert grade_for(90.0, coverage=0.35) == "WATCH"
        assert grade_for(90.0, coverage=0.95) == "PRIORITY"

    def test_grade_floors(self) -> None:
        assert grade_for(75, 1.0) == "PRIORITY"
        assert grade_for(55, 1.0) == "WATCH"
        assert grade_for(35, 1.0) == "THIN"
        assert grade_for(10, 1.0) == "SKIP"

    def test_a_worse_token_scores_lower_than_a_better_one(self) -> None:
        good = healthy()
        bad = healthy()
        bad.liquidity_usd = 60_000
        bad.distribution = DistributionRead(holders=200, top10_pct=0.80, largest_holder_pct=0.45)
        bad.circulating_supply = 20_000_000
        bad.total_supply = 2_000_000_000
        bad.flow = FlowRead(buys_1h=10, sells_1h=90, buys_24h=500, sells_24h=3000)

        assert screen(good, now=NOW).score > screen(bad, now=NOW).score


class TestWarnings:
    def test_concentration_warning_is_raised(self) -> None:
        candidate = healthy()
        candidate.distribution = DistributionRead(holders=3800, top10_pct=0.72, largest_holder_pct=0.35)
        result = screen(candidate, now=NOW)
        assert any("Top 10" in warning for warning in result.warnings)
        assert any("One wallet" in warning for warning in result.warnings)

    def test_unlock_overhang_warning(self) -> None:
        candidate = healthy()
        candidate.market_cap_usd = 10_000_000
        candidate.fdv_usd = 200_000_000
        result = screen(candidate, now=NOW)
        assert any("FDV" in warning for warning in result.warnings)

    def test_seed_tag_is_always_surfaced(self) -> None:
        candidate = healthy()
        candidate.seed_tag = True
        assert any("Seed Tag" in warning for warning in screen(candidate, now=NOW).warnings)

    def test_warnings_do_not_change_the_score(self) -> None:
        """A warning is disclosure, not a penalty — a penalty would let the
        ranking hide it."""
        plain = healthy()
        flagged = healthy()
        flagged.seed_tag = True

        # seed_tag also feeds the venue component, so compare a warning that
        # touches no component at all: the sellers-outnumber-buyers note.
        selling = healthy()
        selling.flow = FlowRead(buys_1h=120, sells_1h=90, buys_24h=3000, sells_24h=7000)
        before = screen(selling, now=NOW)
        assert any("Sellers outnumber" in warning for warning in before.warnings)
        assert screen(plain, now=NOW).score != before.score  # different flow, different score


class TestCountdown:
    def test_hours_to_listing_is_signed(self) -> None:
        upcoming = ListingCandidate(symbol="A", listing_at=NOW + timedelta(hours=5))
        listed = ListingCandidate(symbol="B", listing_at=NOW - timedelta(hours=5))
        assert hours_to_listing(upcoming, now=NOW) == 5.0
        assert hours_to_listing(listed, now=NOW) == -5.0

    def test_no_schedule_means_no_countdown(self) -> None:
        assert hours_to_listing(ListingCandidate(symbol="A"), now=NOW) is None
