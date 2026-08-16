"""Read models for the listings API.

Pure shaping over `repo` — no fetching, no scoring. The worker owns writes;
this is what the screener and the detail page read back.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from . import repo
from .models import TokenListing
from .schemas import (
    AlertResponse,
    HolderMapResponse,
    ListingDetail,
    ListingSummary,
    PricePoint,
    ScoreComponent,
    SocialPulseResponse,
)


def _hours_to_listing(row: TokenListing, now: datetime) -> float | None:
    if row.listing_at is None:
        return None
    return (row.listing_at - now).total_seconds() / 3600.0


def _headline(row: TokenListing) -> str | None:
    """The single most useful line from the score.

    The strongest component wins, because that is what a reader scanning 60
    rows actually wants: not the average, but the reason this one is here.
    """
    detail = row.score_detail or {}
    components = detail.get("components") or []
    if not components:
        return None
    best = max(components, key=lambda component: component.get("score") or 0.0)
    return best.get("evidence")


def _summary(row: TokenListing, now: datetime) -> ListingSummary:
    detail = row.score_detail or {}
    social = row.social_pulse or {}
    holder_map = row.holder_map or {}
    return ListingSummary(
        symbol=row.symbol,
        name=row.name,
        chain=row.chain,
        icon_url=row.icon_url,
        status=row.status,
        hours_to_listing=_hours_to_listing(row, now),
        listing_at=row.listing_at,
        listing_venue=row.listing_venue,
        score=row.score,
        grade=row.grade,
        coverage=row.coverage,
        rejected_because=row.rejected_because,
        current_price=row.current_price,
        launch_price=row.launch_price,
        launch_price_source=row.launch_price_source,
        pct_change_since_launch=row.pct_change_since_launch,
        percent_change_24h=row.percent_change_24h,
        market_cap=row.market_cap,
        fdv=row.fdv,
        liquidity=row.liquidity,
        volume_24h=row.volume_24h,
        holders=row.holders,
        airdrop_live=row.airdrop_live,
        tge_live=row.tge_live,
        hot_tag=row.hot_tag,
        seed_tag=row.seed_tag,
        on_alpha=row.on_alpha,
        on_spot=row.on_spot,
        on_futures=row.on_futures,
        headline=_headline(row),
        warning_count=len(detail.get("warnings") or []),
        social_sentiment=social.get("sentiment"),
        top10_pct=holder_map.get("top10_pct"),
        last_seen_at=row.last_seen_at,
    )


async def list_listings(
    db: AsyncSession,
    *,
    limit: int = 60,
    status: str | None = None,
    grade: str | None = None,
    min_score: float | None = None,
    sort: str = "time",
    include_rejected: bool = False,
) -> tuple[list[ListingSummary], dict[str, Any]]:
    """The screener list.

    Default order is the product requirement — soonest listing first, then
    score. `sort=score` and `sort=change` re-rank in memory, which is cheap at
    this cardinality and keeps one SQL path.
    """
    now = datetime.now(UTC)
    rows = await repo.list_listings(
        db,
        limit=max(limit * 2, limit),
        status=status,
        grade=grade,
        min_score=min_score,
        include_rejected=include_rejected,
    )
    summaries = [_summary(row, now) for row in rows]

    if sort == "score":
        summaries.sort(key=lambda item: (item.score is None, -(item.score or 0.0)))
    elif sort == "change":
        summaries.sort(
            key=lambda item: (
                item.pct_change_since_launch is None,
                -(item.pct_change_since_launch or 0.0),
            )
        )

    summaries = summaries[:limit]
    upcoming = len([item for item in summaries if (item.hours_to_listing or -1) > 0])
    meta = {
        "count": len(summaries),
        "upcoming": upcoming,
        "trading": len(summaries) - upcoming,
        "sort": sort,
        "generated_at": now.isoformat(),
    }
    return summaries, meta


async def get_listing_detail(db: AsyncSession, symbol: str) -> ListingDetail | None:
    row = await repo.get_listing(db, symbol)
    if row is None:
        return None

    now = datetime.now(UTC)
    base = _summary(row, now).model_dump()
    detail = row.score_detail or {}

    holder_map = None
    if row.holder_map:
        holder_map = HolderMapResponse.model_validate(row.holder_map)

    social = None
    if row.social_pulse:
        social = SocialPulseResponse.model_validate(row.social_pulse)

    points = await repo.list_price_points(db, symbol)

    return ListingDetail(
        **base,
        contract_address=row.contract_address,
        coingecko_id=row.coingecko_id,
        announcement_title=row.announcement_title,
        announcement_url=row.announcement_url,
        announced_at=row.announced_at,
        spot_pair=row.spot_pair,
        futures_pair=row.futures_pair,
        alpha_listed_at=row.alpha_listed_at,
        spot_listed_at=row.spot_listed_at,
        futures_listed_at=row.futures_listed_at,
        circulating_supply=row.circulating_supply,
        total_supply=row.total_supply,
        trade_count_24h=row.trade_count_24h,
        alpha_score=row.alpha_score,
        mul_point=row.mul_point,
        max_price_since_launch=row.max_price_since_launch,
        min_price_since_launch=row.min_price_since_launch,
        components=[ScoreComponent.model_validate(c) for c in (detail.get("components") or [])],
        evidence=list(detail.get("evidence") or []),
        warnings=list(detail.get("warnings") or []),
        score_version=row.score_version,
        scored_at=row.scored_at,
        holder_map=holder_map,
        holder_map_at=row.holder_map_at,
        social=social,
        social_pulse_at=row.social_pulse_at,
        price_series=[
            PricePoint(
                observed_at=point.observed_at,
                price=point.price,
                pct_change_since_launch=point.pct_change_since_launch,
                market_cap=point.market_cap,
                volume_24h=point.volume_24h,
                liquidity=point.liquidity,
                score=point.score,
            )
            for point in points
        ],
        first_seen_at=row.first_seen_at,
        inactive=row.inactive,
    )


async def list_alerts(db: AsyncSession, *, limit: int = 50) -> list[AlertResponse]:
    rows = await repo.list_alerts(db, limit=limit)
    return [
        AlertResponse(
            symbol=row.symbol,
            kind=row.kind,
            message=row.message,
            delivered=row.delivered,
            delivery_error=row.delivery_error,
            created_at=row.created_at,
        )
        for row in rows
    ]


def build_ai_brief(detail: ListingDetail) -> dict[str, Any]:
    """The deterministic evidence pack the AI layer narrates.

    Every number here was computed before the model was called, and the
    prompt asks the model to explain *these* — it never fetches, never
    invents a metric, and never produces the score. Same contract the desk
    review and trade-idea prompts already hold.
    """
    return {
        "symbol": detail.symbol,
        "name": detail.name,
        "chain": detail.chain,
        "status": detail.status,
        "listing": {
            "listing_at": detail.listing_at.isoformat() if detail.listing_at else None,
            "hours_to_listing": detail.hours_to_listing,
            "venue": detail.listing_venue,
            "announcement": detail.announcement_title,
            "seed_tag": detail.seed_tag,
            "on_alpha": detail.on_alpha,
            "on_spot": detail.on_spot,
            "on_futures": detail.on_futures,
        },
        "score": {
            "value": detail.score,
            "grade": detail.grade,
            "coverage": detail.coverage,
            "version": detail.score_version,
            "components": [c.model_dump() for c in detail.components],
            "warnings": detail.warnings,
        },
        "price": {
            "current": detail.current_price,
            "launch": detail.launch_price,
            "launch_source": detail.launch_price_source,
            "pct_since_launch": detail.pct_change_since_launch,
            "max_since_launch": detail.max_price_since_launch,
            "min_since_launch": detail.min_price_since_launch,
            "change_24h_pct": detail.percent_change_24h,
        },
        "market": {
            "market_cap": detail.market_cap,
            "fdv": detail.fdv,
            "liquidity": detail.liquidity,
            "volume_24h": detail.volume_24h,
            "circulating_supply": detail.circulating_supply,
            "total_supply": detail.total_supply,
            "holders": detail.holders,
            "trade_count_24h": detail.trade_count_24h,
        },
        "distribution": detail.holder_map.model_dump(exclude={"bubbles"})
        if detail.holder_map
        else None,
        "social": detail.social.model_dump(exclude={"top_posts"}) if detail.social else None,
        "top_posts": [
            post.model_dump()
            for post in (detail.social.top_posts if detail.social else [])
        ][:5],
    }
