"""New-listing screener pass — collect, anchor, score, alert.

Runs on its own cron (every 15 min). Two tiers, because the universe is ~700
tokens and the interesting reads cost one HTTP call *each*:

**Tier 1 — every token, every pass (≈5 requests total).** The Alpha token
list, the spot product list, futures onboarding and the announcement catalog
all return the whole universe in one response. That is enough to keep every
row's price, market shape and venue ladder current, which is what makes the
since-launch percentage on the list view correct for everything — not just
for whatever was recently enriched.

**Tier 2 — a bounded, rotating cohort (`ENRICH_PER_PASS`).** DEX flow, holder
distribution and social pulse are per-token calls, so they go only to tokens
inside the screener window, least-recently-enriched first. Every token gets
its turn; none of them stall the pass. A token that is *about to list* jumps
the queue, since that is the window the whole feature exists for.

The launch anchor is written once, ever, per token — from a Binance kline
open where the token has a pair, from the DEX pool's first hourly bar where
it does not, and from the first price ever observed only as a last resort.
See `repo.set_launch_price`.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from smc.holder_map import HolderMap
from smc.listing_calendar import ListingAnnouncement
from smc.listing_score import (
    LISTING_SCORE_VERSION,
    DistributionRead,
    FlowRead,
    ListingCandidate,
    ListingScore,
    SocialRead,
    hours_to_listing,
    screen,
)
from smc.listing_social import SocialPulse
from sqlalchemy.ext.asyncio import AsyncSession

from app.listings import repo
from app.listings.alerts import dispatch_alerts
from app.listings.holders import fetch_holder_map
from app.listings.social import fetch_social_pulse
from app.listings.sources import (
    AlphaToken,
    DexPair,
    PerpOnboard,
    SpotProduct,
    fetch_alpha_tokens,
    fetch_announcements,
    fetch_coingecko_id,
    fetch_community,
    fetch_dex_pair,
    fetch_launch_price,
    fetch_perp_onboards,
    fetch_pool_launch_price,
    fetch_spot_new_listings,
    hydrate_listing_times,
)

logger = logging.getLogger("worker")

# How far back a listing stays in the screener's working set. Older rows are
# kept forever in the table but are no longer refreshed or enriched.
SCREENER_WINDOW_DAYS = 45
# Per-token enrichment budget for one pass.
ENRICH_PER_PASS = 24
# Enrichment is considered fresh for this long.
ENRICH_TTL_MINUTES = 90
# Holder maps move slowly and cost the most; refresh them less often.
HOLDER_TTL_HOURS = 6


@dataclass(slots=True)
class MergedToken:
    """One token as every Tier-1 feed sees it, before enrichment."""

    symbol: str
    name: str = ""
    chain: str | None = None
    contract_address: str | None = None
    icon_url: str | None = None
    alpha: AlphaToken | None = None
    spot: SpotProduct | None = None
    perp: PerpOnboard | None = None
    announcement: ListingAnnouncement | None = None
    sources: set[str] = field(default_factory=set)


def _merge(
    alpha_tokens: list[AlphaToken],
    spot_products: list[SpotProduct],
    perps: list[PerpOnboard],
    announcements: list[ListingAnnouncement],
) -> dict[str, MergedToken]:
    """Fold four feeds into one row per base asset.

    Alpha leads because it carries the richest payload; the others attach to
    it or create the row when Alpha never had the token (a direct spot
    listing skips Alpha entirely).
    """
    merged: dict[str, MergedToken] = {}

    def slot(symbol: str) -> MergedToken:
        ticker = symbol.strip().upper()
        if ticker not in merged:
            merged[ticker] = MergedToken(symbol=ticker)
        return merged[ticker]

    for token in alpha_tokens:
        if token.fully_delisted:
            continue
        row = slot(token.symbol)
        row.alpha = token
        row.name = row.name or token.name
        row.chain = row.chain or token.chain
        row.contract_address = row.contract_address or token.contract_address
        row.icon_url = row.icon_url or token.icon_url
        row.sources.add("alpha")

    for product in spot_products:
        row = slot(product.symbol)
        row.spot = product
        row.name = row.name or product.name
        row.sources.add("spot")

    for perp in perps:
        row = slot(perp.symbol)
        row.perp = perp
        row.sources.add("futures")

    for announcement in announcements:
        if not announcement.is_listing:
            continue
        for symbol in announcement.symbols:
            row = slot(symbol)
            # Keep the newest announcement that carries an actual time.
            current = row.announcement
            if (
                current is None
                or (announcement.listing_at and not current.listing_at)
                or announcement.published_at > current.published_at
            ):
                row.announcement = announcement
            row.sources.add("announcement")

    return merged


def _venue_fields(token: MergedToken, now: datetime) -> dict[str, Any]:
    """The venue ladder plus the scheduled-listing calendar."""
    alpha = token.alpha
    spot = token.spot
    perp = token.perp
    announcement = token.announcement

    on_alpha = alpha is not None and not alpha.offline
    on_spot = spot is not None
    on_futures = perp is not None

    listing_at: datetime | None = None
    listing_venue: str | None = None
    if announcement is not None and announcement.listing_at is not None:
        listing_at = announcement.listing_at
        listing_venue = announcement.venue
    elif perp is not None:
        listing_at, listing_venue = perp.onboard_at, "FUTURES"
    elif alpha is not None and alpha.listing_time is not None:
        listing_at, listing_venue = alpha.listing_time, "ALPHA"

    if listing_at is not None and listing_at > now:
        status = "UPCOMING"
    elif on_futures:
        status = "FUTURES"
    elif on_spot:
        status = "SPOT"
    elif on_alpha:
        status = "ALPHA"
    elif listing_at is not None:
        # Announced, the date has passed, but the token never appeared on any
        # feed we track — a non-USDT contract (ETHUSD1), a pair outside the
        # perp filter, or a ticker the title parser read too generously. It has
        # listed as far as anyone can tell, so it must not sit in "listing
        # soon" forever; the announcement's own venue is the best label we have.
        status = listing_venue or "SPOT"
    else:
        status = "UPCOMING"

    fields: dict[str, Any] = {
        "status": status,
        "on_alpha": on_alpha,
        "on_spot": on_spot,
        "on_futures": on_futures,
        "spot_pair": spot.pair if spot else None,
        "futures_pair": perp.pair if perp else None,
        "alpha_listed_at": alpha.listing_time if alpha else None,
        "futures_listed_at": perp.onboard_at if perp else None,
        "listing_at": listing_at,
        "listing_venue": listing_venue,
    }
    if announcement is not None:
        fields.update(
            {
                "announced_at": announcement.published_at,
                "announcement_title": announcement.title,
                "announcement_url": announcement.url,
                "seed_tag": announcement.seed_tag,
            }
        )
    return fields


def _market_fields(token: MergedToken) -> dict[str, Any]:
    alpha = token.alpha
    spot = token.spot
    if alpha is not None:
        return {
            "market_cap": alpha.market_cap,
            "fdv": alpha.fdv,
            "liquidity": alpha.liquidity,
            "volume_24h": alpha.volume_24h,
            "percent_change_24h": alpha.percent_change_24h,
            "circulating_supply": alpha.circulating_supply,
            "total_supply": alpha.total_supply,
            "holders": alpha.holders,
            "trade_count_24h": alpha.trade_count_24h,
            "airdrop_live": alpha.airdrop_live,
            "tge_live": alpha.tge_live,
            "hot_tag": alpha.hot_tag,
            "alpha_score": alpha.alpha_score,
            "mul_point": alpha.mul_point,
        }
    if spot is not None:
        return {
            "volume_24h": spot.quote_volume_24h,
            "circulating_supply": spot.circulating_supply,
            "percent_change_24h": (
                (spot.price - spot.open_24h) / spot.open_24h * 100.0
                if spot.price and spot.open_24h
                else None
            ),
        }
    return {}


def _current_price(token: MergedToken) -> float | None:
    if token.alpha is not None and token.alpha.price:
        return token.alpha.price
    if token.spot is not None and token.spot.price:
        return token.spot.price
    return None


def _best_liquidity(feed_liquidity: float | None, dex_pair: DexPair | None) -> float | None:
    """Deepest available read of how much liquidity backs the token.

    The two sources measure different things: Binance Alpha reports the
    token's liquidity *aggregated across pools*, while DexScreener reports one
    pair — the deepest, but still one. For a token whose float is spread over
    several pools the single-pair figure is a lower bound, so taking it
    verbatim scored well-funded tokens as dust. Take the larger, which is the
    only reading that is never an understatement.
    """
    pair_liquidity = dex_pair.liquidity_usd if dex_pair else None
    candidates = [value for value in (feed_liquidity, pair_liquidity) if value and value > 0]
    return max(candidates) if candidates else None


def _plausible_anchor(launch_price: float, current_price: float | None) -> bool:
    """Reject a launch price that can only be a denomination error.

    A DEX pool priced from the wrong side of the pair yields an anchor orders
    of magnitude off, which then prints as a fake -100% since launch. New
    listings genuinely do fall 95%+, so the bound is deliberately loose — it
    only catches the impossible, not the merely brutal.
    """
    if current_price is None or current_price <= 0 or launch_price <= 0:
        return True
    ratio = launch_price / current_price
    return 1 / 500 <= ratio <= 500


async def _anchor_launch_price(
    db: AsyncSession, token: MergedToken, row: Any, dex_pair: DexPair | None
) -> bool:
    """Freeze the launch price, best source available, once.

    Returns True when this call wrote the anchor. Order matters: a Binance
    kline open is the real first traded price on the venue people will
    actually buy on; the DEX pool's first hourly open is the same idea one
    venue earlier; observing the current price is a fallback that is only
    correct if we happened to look at listing time — so it is only used when
    the listing is *fresh*, and it is labelled as such.
    """
    if row.launch_price is not None:
        return False

    # 1. Binance kline open, spot preferred over perp.
    if token.spot is not None and row.spot_listed_at is not None:
        price = await fetch_launch_price(token.spot.pair, row.spot_listed_at, market="spot")
        if price:
            return await repo.set_launch_price(
                db, token.symbol, price=price, at=row.spot_listed_at, source="kline_open"
            )
    if token.perp is not None:
        price = await fetch_launch_price(token.perp.pair, token.perp.onboard_at, market="perp")
        if price:
            return await repo.set_launch_price(
                db, token.symbol, price=price, at=token.perp.onboard_at, source="kline_open"
            )

    # 2. The DEX pool's first hourly bar after the Alpha listing.
    listed_at = row.alpha_listed_at or row.listing_at
    if dex_pair is not None and listed_at is not None and listed_at <= datetime.now(UTC):
        price = await fetch_pool_launch_price(
            token.chain,
            dex_pair.pair_address,
            listed_at,
            token_address=token.contract_address,
        )
        if price and _plausible_anchor(price, _current_price(token)):
            return await repo.set_launch_price(
                db, token.symbol, price=price, at=listed_at, source="pool_open"
            )

    # 3. First observation — only honest for a listing we caught in the act.
    price = _current_price(token)
    now = datetime.now(UTC)
    if price and listed_at is not None and (now - listed_at) <= timedelta(hours=6):
        return await repo.set_launch_price(
            db, token.symbol, price=price, at=now, source="first_observed"
        )
    return False


def _build_candidate(
    token: MergedToken,
    row: Any,
    *,
    dex_pair: DexPair | None,
    holder_map: HolderMap | None,
    pulse: SocialPulse | None,
    community: Any | None,
) -> ListingCandidate:
    """Everything the scorer needs, assembled from the row plus enrichment."""
    flow = None
    if dex_pair is not None:
        flow = FlowRead(
            buys_5m=dex_pair.buys_5m,
            sells_5m=dex_pair.sells_5m,
            buys_1h=dex_pair.buys_1h,
            sells_1h=dex_pair.sells_1h,
            buys_24h=dex_pair.buys_24h,
            sells_24h=dex_pair.sells_24h,
            volume_1h_usd=dex_pair.volume_1h_usd,
            volume_24h_usd=dex_pair.volume_24h_usd,
            price_change_1h_pct=dex_pair.price_change_1h,
            price_change_24h_pct=dex_pair.price_change_24h,
        )

    distribution = None
    if holder_map is not None:
        distribution = DistributionRead(
            holders=row.holders,
            top10_pct=holder_map.top10_pct,
            top50_pct=holder_map.top50_pct,
            largest_holder_pct=holder_map.largest_holder_pct,
            available=holder_map.unavailable_reason is None,
            unavailable_reason=(
                "Holder distribution unavailable on this chain."
                if holder_map.unavailable_reason
                else None
            ),
        )
    elif row.holders:
        distribution = DistributionRead(holders=row.holders)

    social = None
    if pulse is not None or community is not None:
        social = SocialRead(
            sentiment_up_pct=getattr(community, "sentiment_up_pct", None),
            watchlist_users=getattr(community, "watchlist_users", None),
            telegram_members=getattr(community, "telegram_members", None),
            posts_24h=pulse.posts_24h if pulse else None,
            post_sentiment=pulse.sentiment if pulse else None,
            available=bool((pulse and pulse.available) or community is not None),
        )

    return ListingCandidate(
        symbol=token.symbol,
        name=row.name or token.name,
        chain=row.chain,
        on_alpha=row.on_alpha,
        on_spot=row.on_spot,
        on_futures=row.on_futures,
        announced_at=row.announced_at,
        listing_at=row.listing_at,
        seed_tag=row.seed_tag,
        airdrop_live=row.airdrop_live,
        tge_live=row.tge_live,
        hot_tag=row.hot_tag,
        price_usd=row.current_price,
        market_cap_usd=row.market_cap,
        fdv_usd=row.fdv,
        liquidity_usd=_best_liquidity(row.liquidity, dex_pair),
        volume_24h_usd=row.volume_24h,
        circulating_supply=row.circulating_supply,
        total_supply=row.total_supply,
        flow=flow,
        distribution=distribution,
        social=social,
        listed_at=row.alpha_listed_at or row.spot_listed_at or row.futures_listed_at,
    )


def _score_detail(score: ListingScore) -> dict[str, Any]:
    return {
        "components": [
            {
                "key": component.key,
                "score": round(component.score, 4),
                "weight": component.weight,
                "evidence": component.evidence,
            }
            for component in score.components
        ],
        "evidence": score.evidence,
        "warnings": score.warnings,
        "coverage": score.coverage,
        "version": score.version,
    }


def _holder_map_json(holder_map: HolderMap) -> dict[str, Any]:
    return {
        "top10_pct": holder_map.top10_pct,
        "top50_pct": holder_map.top50_pct,
        "largest_holder_pct": holder_map.largest_holder_pct,
        "hhi": holder_map.hhi,
        "holders_counted": holder_map.holders_counted,
        "pool_pct": holder_map.pool_pct,
        "burn_pct": holder_map.burn_pct,
        "unavailable_reason": holder_map.unavailable_reason,
        "version": holder_map.version,
        "bubbles": [
            {
                "address": bubble.address,
                "label": bubble.label,
                "kind": bubble.kind,
                "pct": round(bubble.pct, 6),
                "x": bubble.x,
                "y": bubble.y,
                "r": bubble.r,
                "counted": bubble.counted,
            }
            for bubble in holder_map.bubbles
        ],
    }


def _pulse_json(pulse: SocialPulse) -> dict[str, Any]:
    return {
        "sentiment": pulse.sentiment,
        "posts_total": pulse.posts_total,
        "posts_24h": pulse.posts_24h,
        "posts_1h": pulse.posts_1h,
        "velocity": pulse.velocity,
        "spam_ratio": pulse.spam_ratio,
        "reach": pulse.reach,
        "bullish_share": pulse.bullish_share,
        "bearish_share": pulse.bearish_share,
        "sources": pulse.sources,
        "unavailable_reason": pulse.unavailable_reason,
        "version": pulse.version,
        "top_posts": [
            {
                "id": scored.post.id,
                "source": scored.post.source,
                "author": scored.post.author,
                "text": scored.post.text[:400],
                "url": scored.post.url,
                "created_at": scored.post.created_at.isoformat(),
                "likes": scored.post.likes,
                "reposts": scored.post.reposts,
                "replies": scored.post.replies,
                "followers": scored.post.author_followers,
                "sentiment": round(scored.sentiment, 3),
                "age_hours": round(scored.age_hours, 2),
            }
            for scored in pulse.top_posts
        ],
    }


def _enrichment_cohort(
    merged: dict[str, MergedToken], rows: dict[str, Any], now: datetime
) -> list[str]:
    """Which tokens get the per-token calls this pass.

    Anything listing within 48h is enriched unconditionally — that is the
    window the screener exists to cover. The remaining budget goes to the
    least-recently-enriched tokens inside the screener window, so coverage
    rotates instead of starving the tail.
    """
    window_start = now - timedelta(days=SCREENER_WINDOW_DAYS)
    stale_before = now - timedelta(minutes=ENRICH_TTL_MINUTES)

    urgent: list[str] = []
    eligible: list[tuple[datetime, str]] = []

    for symbol in merged:
        row = rows.get(symbol)
        if row is None:
            continue
        listed_at = row.alpha_listed_at or row.spot_listed_at or row.futures_listed_at
        upcoming = row.listing_at is not None and row.listing_at > now
        if not upcoming and (listed_at is None or listed_at < window_start):
            continue

        remaining = (
            (row.listing_at - now).total_seconds() / 3600.0 if row.listing_at else None
        )
        if upcoming and remaining is not None and remaining <= 48:
            urgent.append(symbol)
            continue

        last = row.scored_at or datetime.min.replace(tzinfo=UTC)
        if last > stale_before:
            continue
        eligible.append((last, symbol))

    eligible.sort(key=lambda pair: pair[0])
    budget = max(0, ENRICH_PER_PASS - len(urgent))
    return urgent + [symbol for _, symbol in eligible[:budget]]


async def _enrich(
    token: MergedToken, row: Any, now: datetime
) -> tuple[DexPair | None, HolderMap | None, SocialPulse | None, Any | None]:
    """The per-token calls, each independently degradable."""
    dex_pair: DexPair | None = None
    holder_map: HolderMap | None = None
    pulse: SocialPulse | None = None
    community: Any | None = None

    if token.contract_address:
        dex_pair = await fetch_dex_pair(token.contract_address)

    holder_stale = (
        row.holder_map_at is None or (now - row.holder_map_at) > timedelta(hours=HOLDER_TTL_HOURS)
    )
    if holder_stale and token.contract_address:
        holder_map = await fetch_holder_map(
            token.symbol,
            chain=token.chain,
            contract_address=token.contract_address,
            total_supply=row.total_supply,
        )

    pulse = await fetch_social_pulse(token.symbol, row.name or token.name)

    coin_id = row.coingecko_id
    if not coin_id and token.contract_address:
        coin_id = await fetch_coingecko_id(token.chain, token.contract_address)
    if coin_id:
        community = await fetch_community(coin_id)

    return dex_pair, holder_map, pulse, community


async def _watchlisted_symbols(db: AsyncSession) -> set[str]:
    """Symbols any signed-in user is watching.

    `user_watchlist` belongs to the retained web tier and has no SQLAlchemy
    model on this side, so it is read as plain SQL. A missing table (fresh
    dev DB) must not break the pass.
    """
    try:
        result = await db.execute(sa.text("select distinct symbol from user_watchlist"))
        return {str(row[0]).strip().upper() for row in result.fetchall() if row[0]}
    except Exception as exc:
        logger.info("listings: watchlist unavailable (%s)", type(exc).__name__)
        return set()


async def run_listings_pass(db: AsyncSession) -> str:
    """One full pass. Returns a one-line heartbeat summary."""
    now = datetime.now(UTC)

    alpha_tokens, spot_products, perps, announcements = await asyncio.gather(
        fetch_alpha_tokens(),
        fetch_spot_new_listings(),
        fetch_perp_onboards(),
        fetch_announcements(),
        return_exceptions=False,
    )
    announcements = await hydrate_listing_times(announcements)

    merged = _merge(alpha_tokens, spot_products, perps, announcements)
    if not merged:
        return "listings: no upstream data, nothing written"

    # ── Tier 1: every token ─────────────────────────────────────────────────
    rows: dict[str, Any] = {}
    for symbol, token in merged.items():
        fields: dict[str, Any] = {
            "name": token.name or symbol,
            "chain": token.chain,
            "contract_address": token.contract_address,
            "icon_url": token.icon_url,
            "last_seen_at": now,
            "inactive": False,
        }
        fields.update(_venue_fields(token, now))
        fields.update(_market_fields(token))
        rows[symbol] = await repo.upsert_listing(db, symbol, fields)

        price = _current_price(token)
        if price:
            await repo.update_price(db, symbol, price=price, observed_at=now)
    await db.commit()

    # A token that stopped appearing anywhere keeps its row; it is only
    # flagged so the list view can hide it.
    known = await repo.get_all_symbols(db)
    missing = [
        symbol
        for symbol, row in known.items()
        if symbol not in merged
        and not row.inactive
        and (now - row.last_seen_at) > timedelta(days=3)
    ]
    if missing:
        await repo.mark_inactive(db, missing)
        await db.commit()

    # ── Tier 2: bounded enrichment + scoring ────────────────────────────────
    cohort = _enrichment_cohort(merged, rows, now)
    scored_count = 0
    alerts_sent = 0
    watched = await _watchlisted_symbols(db)

    for symbol in cohort:
        token = merged[symbol]
        row = rows[symbol]
        try:
            dex_pair, holder_map, pulse, community = await _enrich(token, row, now)
        except Exception as exc:
            logger.warning("listings: enrichment failed for %s: %s", symbol, exc)
            continue

        anchored = await _anchor_launch_price(db, token, row, dex_pair)
        if anchored:
            # The Tier-1 price update ran before this token had an anchor, so
            # its since-launch percentage was skipped. Re-derive it now rather
            # than leaving the column empty until the next pass.
            price = _current_price(token)
            if price:
                await repo.update_price(db, symbol, price=price, observed_at=now)

        candidate = _build_candidate(
            token,
            row,
            dex_pair=dex_pair,
            holder_map=holder_map,
            pulse=pulse,
            community=community,
        )
        score = screen(candidate, now=now)

        updates: dict[str, Any] = {
            "score": score.score if not score.screened_out else None,
            "grade": score.grade,
            "coverage": score.coverage,
            "score_version": LISTING_SCORE_VERSION,
            "scored_at": now,
            "rejected_because": score.rejected_because,
            "score_detail": _score_detail(score),
        }
        if dex_pair is not None:
            updates["liquidity"] = _best_liquidity(row.liquidity, dex_pair)
            updates["market_cap"] = dex_pair.market_cap_usd or row.market_cap
            updates["fdv"] = dex_pair.fdv_usd or row.fdv
        if holder_map is not None:
            updates["holder_map"] = _holder_map_json(holder_map)
            updates["holder_map_at"] = now
        if pulse is not None:
            updates["social_pulse"] = _pulse_json(pulse)
            updates["social_pulse_at"] = now
        if community is not None:
            updates["coingecko_id"] = community.coin_id

        refreshed = await repo.upsert_listing(db, symbol, updates)
        scored_count += 1

        if refreshed.current_price:
            await repo.append_price_point(
                db,
                symbol,
                price=refreshed.current_price,
                pct_change_since_launch=refreshed.pct_change_since_launch,
                market_cap=refreshed.market_cap,
                volume_24h=refreshed.volume_24h,
                liquidity=refreshed.liquidity,
                score=refreshed.score,
                observed_at=now,
            )
        await db.commit()

        if symbol in watched:
            alerts_sent += await dispatch_alerts(db, refreshed, now=now)

    await db.commit()

    upcoming = sum(
        1
        for row in rows.values()
        if row.listing_at is not None and row.listing_at > now
    )
    logger.info(
        "listings: %d tokens tracked, %d upcoming, %d scored, %d alerts",
        len(merged),
        upcoming,
        scored_count,
        alerts_sent,
    )
    return (
        f"listings: {len(merged)} tracked, {upcoming} upcoming, "
        f"{scored_count} scored, {alerts_sent} alerts"
    )


def next_listing_countdown(row: Any, now: datetime | None = None) -> float | None:
    """Hours until this row's scheduled listing — re-exported for the API."""
    candidate = ListingCandidate(symbol=row.symbol, listing_at=row.listing_at)
    return hours_to_listing(candidate, now=now)
