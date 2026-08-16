"""Listing screener score — "which new listing is worth opening at all?"

A new listing has no price history, so nothing in `smc/` that reads structure
applies to it. What it *does* have is a shape: how much real liquidity backs
it, how concentrated its holders are, whether buyers or sellers are hitting
it right now, how much supply is still locked, and where it sits on the
venue ladder (Alpha -> announced -> spot -> perp). This module folds exactly
those into one comparable number, the way a DEX screener does, and — like
`situation.py` — publishes an **evidence list** rather than a bare score.

Three rules keep it honest:

1. **Rejection before ranking.** `screen()` first asks whether the token is
   disqualified (dead feed, dust liquidity, unreadable supply). A rejected
   token gets no score at all, and the reason ships to the UI. A score is
   only ever computed on a token that survived the gate.
2. **Missing input is never a good input.** Every component returns None when
   its feed is absent, and the composite renormalizes over the components it
   actually has, recording `coverage`. A token scored on two of six
   components is reported as such instead of quietly inheriting a default.
3. **It is a screener, not a signal.** The output ranks *attention*, never
   direction or size. No entry, no stop, no BUY. That boundary is the same
   one `discovery.py` and `structural_path.py` hold.

Own version, never ENGINE_VERSION — nothing here touches decision or trigger
semantics or any forward-test record.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

LISTING_SCORE_VERSION = "1.0.0"

Grade = Literal["PRIORITY", "WATCH", "THIN", "SKIP"]

# Hard floors. Below these the token is not scored at all — a 90 on dust is
# still dust, and ranking it would be the single most misleading thing this
# module could do.
MIN_LIQUIDITY_USD = 15_000.0
MIN_VOLUME_24H_USD = 25_000.0

# Component weights. They need not sum to 1 — the composite renormalizes over
# whichever components have data — but they are written to.
WEIGHTS: dict[str, float] = {
    "liquidity": 0.22,
    "flow": 0.20,
    "distribution": 0.20,
    "supply": 0.15,
    "venue": 0.13,
    "social": 0.10,
}

GRADE_FLOORS: tuple[tuple[float, Grade], ...] = (
    (70.0, "PRIORITY"),
    (50.0, "WATCH"),
    (30.0, "THIN"),
)

# Coverage below this means too few components carried data for the composite
# to mean anything; the score is still reported, but never above THIN.
MIN_COVERAGE_FOR_PRIORITY = 0.60


@dataclass(slots=True)
class FlowRead:
    """Realtime taker flow from the DEX pair, the one input that updates on a
    minute scale. Buys/sells are trade counts, not size."""

    buys_5m: int = 0
    sells_5m: int = 0
    buys_1h: int = 0
    sells_1h: int = 0
    buys_24h: int = 0
    sells_24h: int = 0
    volume_1h_usd: float = 0.0
    volume_24h_usd: float = 0.0
    price_change_1h_pct: float | None = None
    price_change_24h_pct: float | None = None


@dataclass(slots=True)
class DistributionRead:
    """Holder concentration. `top10_pct` excludes pool/burn/bridge addresses —
    an LP contract holding 40% is liquidity, not a whale."""

    holders: int | None = None
    top10_pct: float | None = None
    top50_pct: float | None = None
    largest_holder_pct: float | None = None
    # False when no indexer covers this chain; the component is then skipped
    # rather than scored as if the token were perfectly distributed.
    available: bool = True
    unavailable_reason: str | None = None


@dataclass(slots=True)
class SocialRead:
    """Crowd attention. Kept separate from flow: talk and money are different
    evidence and are weighted differently."""

    sentiment_up_pct: float | None = None
    watchlist_users: int | None = None
    telegram_members: int | None = None
    twitter_followers: int | None = None
    # Rolling post stats from the social collector (see `listing_social.py`).
    posts_24h: int | None = None
    post_sentiment: float | None = None
    available: bool = True


@dataclass(slots=True)
class ListingCandidate:
    """Everything the screener knows about one token, from every source."""

    symbol: str
    name: str = ""
    chain: str | None = None
    # Venue reached so far, and what is scheduled next.
    on_alpha: bool = False
    on_spot: bool = False
    on_futures: bool = False
    announced_at: datetime | None = None
    listing_at: datetime | None = None
    seed_tag: bool = False
    airdrop_live: bool = False
    tge_live: bool = False
    hot_tag: bool = False
    # Market shape.
    price_usd: float | None = None
    market_cap_usd: float | None = None
    fdv_usd: float | None = None
    liquidity_usd: float | None = None
    volume_24h_usd: float | None = None
    circulating_supply: float | None = None
    total_supply: float | None = None
    # Sub-reads.
    flow: FlowRead | None = None
    distribution: DistributionRead | None = None
    social: SocialRead | None = None
    # Age of the listing itself, used to damp brand-new noise.
    listed_at: datetime | None = None


@dataclass(slots=True)
class Component:
    key: str
    score: float
    weight: float
    evidence: str


@dataclass(slots=True)
class ListingScore:
    symbol: str
    score: float
    grade: Grade
    coverage: float
    components: list[Component] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    rejected_because: str | None = None
    version: str = LISTING_SCORE_VERSION

    @property
    def screened_out(self) -> bool:
        return self.rejected_because is not None


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _log_scale(value: float, floor: float, ceiling: float) -> float:
    """0 at `floor`, 1 at `ceiling`, log-spaced between — the natural shape for
    holder counts and dollar amounts, where 10k->100k matters as much as
    100k->1M."""
    if value <= floor:
        return 0.0
    if value >= ceiling:
        return 1.0
    return _clamp(math.log(value / floor) / math.log(ceiling / floor))


# ── rejection gate ───────────────────────────────────────────────────────────


def reject_reason(candidate: ListingCandidate, *, now: datetime | None = None) -> str | None:
    """Why this token should not be ranked at all, or None.

    Ordered cheapest-and-most-decisive first so the reason shown to the user
    is the one that actually matters.

    Takes `now` for the same reason everything else here does: the gate turns on
    whether the listing is still ahead, so reading the wall clock instead would
    make the whole gate untestable and would silently reclassify a candidate the
    moment its launch time passed mid-pass.
    """
    if candidate.price_usd is None or candidate.price_usd <= 0:
        return "no_price_feed"

    liquidity = candidate.liquidity_usd
    volume = candidate.volume_24h_usd
    # A token still awaiting its listing has no market yet — absent liquidity
    # is expected, not disqualifying. It is judged on the calendar instead.
    if is_upcoming(candidate, now=now):
        return None

    if liquidity is not None and liquidity < MIN_LIQUIDITY_USD:
        return "liquidity_below_floor"
    if volume is not None and volume < MIN_VOLUME_24H_USD:
        return "volume_below_floor"
    if liquidity is None and volume is None:
        return "no_market_data"
    return None


def is_upcoming(candidate: ListingCandidate, *, now: datetime | None = None) -> bool:
    """Announced with a launch time still in the future."""
    if candidate.listing_at is None:
        return False
    reference = now or datetime.now(UTC)
    return candidate.listing_at > reference


def hours_to_listing(candidate: ListingCandidate, *, now: datetime | None = None) -> float | None:
    """Signed hours until launch — negative once it has listed. This is the
    primary sort key for the screener list."""
    if candidate.listing_at is None:
        return None
    reference = now or datetime.now(UTC)
    return (candidate.listing_at - reference).total_seconds() / 3600.0


# ── components ───────────────────────────────────────────────────────────────


def score_liquidity(candidate: ListingCandidate) -> Component | None:
    """Depth, and depth relative to what the market thinks the token is worth.

    A $2M cap backed by $30k of liquidity is a different instrument from the
    same cap backed by $2M, and the ratio is what separates them.
    """
    liquidity = candidate.liquidity_usd
    if liquidity is None or liquidity <= 0:
        return None

    depth = _log_scale(liquidity, 25_000, 5_000_000)
    evidence = f"${liquidity:,.0f} pooled liquidity"

    cap = candidate.market_cap_usd
    if cap and cap > 0:
        ratio = liquidity / cap
        # 1% of cap pooled is thin, 10% is deep. Anything above is either a
        # very early pool or a mispriced cap; both cap out at 1.
        backing = _clamp((ratio - 0.01) / 0.09)
        score = 0.6 * depth + 0.4 * backing
        evidence += f", {ratio * 100:.1f}% of market cap"
    else:
        score = depth

    turnover = candidate.volume_24h_usd
    if turnover and liquidity > 0:
        churn = turnover / liquidity
        evidence += f", {churn:.1f}x daily turnover"

    return Component("liquidity", _clamp(score), WEIGHTS["liquidity"], evidence)


def score_flow(candidate: ListingCandidate) -> Component | None:
    """Who is actually hitting the book right now.

    Buy/sell *counts* rather than size, because size on a new listing is
    dominated by a handful of wallets while counts describe participation.
    The 1h window leads, the 24h window is the baseline it is judged against.
    """
    flow = candidate.flow
    if flow is None:
        return None

    total_1h = flow.buys_1h + flow.sells_1h
    total_24h = flow.buys_24h + flow.sells_24h
    if total_24h <= 0:
        return None

    parts: list[str] = []

    # Buy share in the recent window, centred on 0.5 = balanced.
    if total_1h >= 10:
        buy_share = flow.buys_1h / total_1h
        parts.append(f"{buy_share * 100:.0f}% buys in the last hour")
    else:
        buy_share = flow.buys_24h / total_24h
        parts.append(f"{buy_share * 100:.0f}% buys over 24h")
    imbalance = _clamp((buy_share - 0.40) / 0.25)

    # Participation depth: a pair with 50 trades a day is not a market.
    participation = _log_scale(total_24h, 200, 20_000)
    parts.append(f"{total_24h:,} trades/24h")

    # Is activity accelerating or bleeding out? 1/24th of the day's trades in
    # the last hour is flat; more is acceleration.
    acceleration = 0.5
    if total_1h > 0 and total_24h > 0:
        expected = total_24h / 24.0
        if expected > 0:
            acceleration = _clamp(math.log((total_1h / expected) + 0.5) / math.log(4.0) + 0.5)
            if total_1h > expected * 1.5:
                parts.append("activity accelerating")
            elif total_1h < expected * 0.5:
                parts.append("activity cooling")

    score = 0.45 * imbalance + 0.35 * participation + 0.20 * acceleration
    return Component("flow", _clamp(score), WEIGHTS["flow"], ", ".join(parts))


def score_distribution(candidate: ListingCandidate) -> Component | None:
    """Holder concentration — the risk a new listing most reliably hides.

    Scored inverted: less concentrated is better. Holder *count* is a weak
    second input, because it is trivially farmed.
    """
    dist = candidate.distribution
    if dist is None or not dist.available:
        return None

    parts: list[str] = []
    concentration_score: float | None = None

    if dist.top10_pct is not None:
        # 20% in the top 10 (ex-pool) is healthy for a new token; 70% is a
        # cartel. Linear between, because every point in that range is real.
        concentration_score = _clamp((0.70 - dist.top10_pct) / 0.50)
        parts.append(f"top 10 hold {dist.top10_pct * 100:.1f}%")

    if dist.largest_holder_pct is not None:
        single = _clamp((0.25 - dist.largest_holder_pct) / 0.20)
        concentration_score = (
            single if concentration_score is None else 0.7 * concentration_score + 0.3 * single
        )
        parts.append(f"largest wallet {dist.largest_holder_pct * 100:.1f}%")

    holder_score = None
    if dist.holders is not None and dist.holders > 0:
        holder_score = _log_scale(float(dist.holders), 250, 50_000)
        parts.append(f"{dist.holders:,} holders")

    if concentration_score is None and holder_score is None:
        return None
    if concentration_score is None:
        score = holder_score or 0.0
    elif holder_score is None:
        score = concentration_score
    else:
        score = 0.75 * concentration_score + 0.25 * holder_score

    return Component("distribution", _clamp(score), WEIGHTS["distribution"], ", ".join(parts))


def score_supply(candidate: ListingCandidate) -> Component | None:
    """Unlock overhang. A 5% float against a 20x FDV is a countdown, and it is
    the most common way a good-looking new listing bleeds for months."""
    circulating = candidate.circulating_supply
    total = candidate.total_supply
    cap = candidate.market_cap_usd
    fdv = candidate.fdv_usd

    float_ratio: float | None = None
    if circulating and total and total > 0:
        float_ratio = _clamp(circulating / total)
    elif cap and fdv and fdv > 0:
        float_ratio = _clamp(cap / fdv)

    if float_ratio is None:
        return None

    # 10% float scores 0, 60%+ scores 1 — above 60% the remaining overhang
    # stops being the dominant risk.
    score = _clamp((float_ratio - 0.10) / 0.50)
    evidence = f"{float_ratio * 100:.0f}% of supply circulating"
    if fdv and cap and cap > 0:
        evidence += f", FDV {fdv / cap:.1f}x market cap"
    return Component("supply", score, WEIGHTS["supply"], evidence)


def score_venue(candidate: ListingCandidate, *, now: datetime | None = None) -> Component:
    """Where the token sits on Binance's ladder, and what is scheduled next.

    The rungs are cumulative evidence of Binance's own diligence, and a
    *scheduled, not yet live* listing is its own state — that is the window
    this whole screener exists to surface.
    """
    parts: list[str] = []
    score = 0.0

    if candidate.on_futures:
        score = max(score, 0.85)
        parts.append("perp listed")
    if candidate.on_spot:
        score = max(score, 0.75)
        parts.append("spot listed")
    if candidate.on_alpha:
        score = max(score, 0.45)
        parts.append("on Binance Alpha")

    remaining = hours_to_listing(candidate, now=now)
    if remaining is not None and remaining > 0:
        # Nearest scheduled listings score highest: inside 24h is the event.
        proximity = _clamp(1.0 - (remaining / 168.0))
        score = max(score, 0.55 + 0.40 * proximity)
        parts.append(f"listing scheduled in {remaining:.0f}h")
    elif remaining is not None and remaining > -72:
        parts.append(f"listed {abs(remaining):.0f}h ago")

    if candidate.airdrop_live:
        score = min(1.0, score + 0.05)
        parts.append("airdrop live")
    if candidate.tge_live:
        parts.append("TGE live")
    if candidate.seed_tag:
        parts.append("Seed Tag")

    if not parts:
        parts.append("not yet on any Binance venue")

    return Component("venue", _clamp(score), WEIGHTS["venue"], ", ".join(parts))


def score_social(candidate: ListingCandidate) -> Component | None:
    """Attention, from votes and posts rather than money."""
    social = candidate.social
    if social is None or not social.available:
        return None

    signals: list[tuple[float, float]] = []  # (score, weight)
    parts: list[str] = []

    if social.post_sentiment is not None and (social.posts_24h or 0) > 0:
        # post_sentiment is -1..1; map onto 0..1.
        signals.append(((social.post_sentiment + 1.0) / 2.0, 0.45))
        parts.append(f"{social.posts_24h} posts/24h, sentiment {social.post_sentiment:+.2f}")
    if social.sentiment_up_pct is not None:
        signals.append((_clamp(social.sentiment_up_pct / 100.0), 0.25))
        parts.append(f"{social.sentiment_up_pct:.0f}% bullish votes")
    if social.watchlist_users:
        signals.append((_log_scale(float(social.watchlist_users), 50, 50_000), 0.15))
        parts.append(f"{social.watchlist_users:,} watchlisting")
    if social.telegram_members:
        signals.append((_log_scale(float(social.telegram_members), 500, 200_000), 0.15))
        parts.append(f"{social.telegram_members:,} in Telegram")

    if not signals:
        return None

    total_weight = sum(weight for _, weight in signals)
    score = sum(value * weight for value, weight in signals) / total_weight
    return Component("social", _clamp(score), WEIGHTS["social"], ", ".join(parts))


# ── composite ────────────────────────────────────────────────────────────────


def _warnings(candidate: ListingCandidate, components: dict[str, Component]) -> list[str]:
    """Things a buyer should see even when the composite looks good. These are
    never folded into the number — a warning that moves the score is a
    warning the ranking can hide."""
    out: list[str] = []
    dist = candidate.distribution

    if dist is not None and not dist.available:
        out.append(dist.unavailable_reason or "Holder distribution unavailable on this chain.")
    if dist is not None and dist.top10_pct is not None and dist.top10_pct > 0.60:
        out.append(f"Top 10 wallets hold {dist.top10_pct * 100:.0f}% — concentrated supply.")
    if dist is not None and dist.largest_holder_pct is not None and dist.largest_holder_pct > 0.30:
        out.append(f"One wallet holds {dist.largest_holder_pct * 100:.0f}%.")

    if candidate.fdv_usd and candidate.market_cap_usd and candidate.market_cap_usd > 0:
        multiple = candidate.fdv_usd / candidate.market_cap_usd
        if multiple >= 5:
            out.append(f"FDV is {multiple:.0f}x market cap — heavy unlock overhang ahead.")

    flow = candidate.flow
    if flow is not None:
        total_24h = flow.buys_24h + flow.sells_24h
        if total_24h > 0 and flow.sells_24h / total_24h > 0.60:
            out.append("Sellers outnumber buyers over 24h.")

    if candidate.seed_tag:
        out.append("Binance Seed Tag: explicitly higher-risk, early-stage listing.")
    if candidate.liquidity_usd is not None and candidate.liquidity_usd < 100_000:
        out.append("Liquidity under $100k — expect heavy slippage on size.")

    if "social" not in components:
        out.append("No social coverage collected for this token yet.")

    return out


def grade_for(score: float, coverage: float) -> Grade:
    for floor, grade in GRADE_FLOORS:
        if score >= floor:
            if grade == "PRIORITY" and coverage < MIN_COVERAGE_FOR_PRIORITY:
                return "WATCH"
            return grade
    return "SKIP"


def screen(candidate: ListingCandidate, *, now: datetime | None = None) -> ListingScore:
    """Rejection gate, then composite. The one entry point."""
    rejection = reject_reason(candidate, now=now)
    if rejection is not None:
        return ListingScore(
            symbol=candidate.symbol,
            score=0.0,
            grade="SKIP",
            coverage=0.0,
            rejected_because=rejection,
            evidence=[],
        )

    maybe = [
        score_liquidity(candidate),
        score_flow(candidate),
        score_distribution(candidate),
        score_supply(candidate),
        score_venue(candidate, now=now),
        score_social(candidate),
    ]
    components = [component for component in maybe if component is not None]
    by_key = {component.key: component for component in components}

    weight_present = sum(component.weight for component in components)
    weight_total = sum(WEIGHTS.values())
    coverage = weight_present / weight_total if weight_total else 0.0

    if weight_present <= 0:
        return ListingScore(
            symbol=candidate.symbol,
            score=0.0,
            grade="SKIP",
            coverage=0.0,
            rejected_because="no_scoreable_inputs",
        )

    raw = sum(component.score * component.weight for component in components) / weight_present
    score = round(raw * 100.0, 1)

    return ListingScore(
        symbol=candidate.symbol,
        score=score,
        grade=grade_for(score, coverage),
        coverage=round(coverage, 3),
        components=components,
        evidence=[f"{component.key}: {component.evidence}" for component in components],
        warnings=_warnings(candidate, by_key),
    )
