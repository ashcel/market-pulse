"""The only SQL surface for the listing screener.

Two invariants are enforced here rather than trusted to callers, because both
are one careless UPDATE away from destroying the record:

1. **`launch_price` is write-once.** `set_launch_price` refuses to overwrite a
   non-null anchor. Everything downstream — the since-launch percentage, the
   extremes, the price series — is meaningless if the anchor can move.
2. **Nothing is ever deleted.** There is no delete function in this module.
   A token that vanishes upstream is marked `inactive`; its row, its price
   history and its alerts stay.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ListingAlert, TokenListing, TokenListingPricePoint

# Fields a pass is allowed to refresh on an existing row. Deliberately
# enumerated: anything not in here (launch price, first_seen_at, id) is
# immutable once written.
MUTABLE_FIELDS = frozenset(
    {
        "name",
        "chain",
        "contract_address",
        "icon_url",
        "coingecko_id",
        "status",
        "on_alpha",
        "on_spot",
        "on_futures",
        "spot_pair",
        "futures_pair",
        "alpha_listed_at",
        "spot_listed_at",
        "futures_listed_at",
        "listing_at",
        "listing_venue",
        "announced_at",
        "announcement_title",
        "announcement_url",
        "seed_tag",
        "current_price",
        "price_updated_at",
        "pct_change_since_launch",
        "max_price_since_launch",
        "min_price_since_launch",
        "market_cap",
        "fdv",
        "liquidity",
        "volume_24h",
        "percent_change_24h",
        "circulating_supply",
        "total_supply",
        "holders",
        "trade_count_24h",
        "airdrop_live",
        "tge_live",
        "hot_tag",
        "alpha_score",
        "mul_point",
        "score",
        "grade",
        "coverage",
        "score_version",
        "scored_at",
        "rejected_because",
        "score_detail",
        "holder_map",
        "holder_map_at",
        "social_pulse",
        "social_pulse_at",
        "ai_analysis",
        "ai_analysis_at",
        "last_seen_at",
        "inactive",
    }
)


async def get_listing(db: AsyncSession, symbol: str) -> TokenListing | None:
    result = await db.execute(
        sa.select(TokenListing).where(TokenListing.symbol == symbol.strip().upper())
    )
    return result.scalar_one_or_none()


async def get_all_symbols(db: AsyncSession) -> dict[str, TokenListing]:
    result = await db.execute(sa.select(TokenListing))
    return {row.symbol: row for row in result.scalars().all()}


async def upsert_listing(db: AsyncSession, symbol: str, fields: dict[str, Any]) -> TokenListing:
    """Insert a new token or refresh a known one.

    Returns the live row. `launch_price` is never touched here — use
    `set_launch_price`.
    """
    ticker = symbol.strip().upper()
    updates = {key: value for key, value in fields.items() if key in MUTABLE_FIELDS}
    updates["last_seen_at"] = updates.get("last_seen_at") or datetime.now(UTC)

    existing = await get_listing(db, ticker)
    if existing is None:
        row = TokenListing(symbol=ticker, **updates)
        db.add(row)
        await db.flush()
        return row

    for key, value in updates.items():
        # A refresh must not blank a field the current pass simply could not
        # read — a dead provider would otherwise erase good data.
        if value is None and getattr(existing, key, None) is not None:
            continue
        setattr(existing, key, value)
    await db.flush()
    return existing


async def set_launch_price(
    db: AsyncSession,
    symbol: str,
    *,
    price: float,
    at: datetime,
    source: str,
) -> bool:
    """Freeze the launch anchor. Returns False if one already exists.

    Write-once by design — see the module docstring.
    """
    row = await get_listing(db, symbol)
    if row is None or price <= 0:
        return False
    if row.launch_price is not None:
        return False
    row.launch_price = price
    row.launch_price_at = at
    row.launch_price_source = source
    if row.max_price_since_launch is None:
        row.max_price_since_launch = price
    if row.min_price_since_launch is None:
        row.min_price_since_launch = price
    await db.flush()
    return True


async def update_price(
    db: AsyncSession, symbol: str, *, price: float, observed_at: datetime | None = None
) -> TokenListing | None:
    """Refresh current price and re-derive everything anchored to launch."""
    row = await get_listing(db, symbol)
    if row is None or price <= 0:
        return None

    row.current_price = price
    row.price_updated_at = observed_at or datetime.now(UTC)
    if row.launch_price and row.launch_price > 0:
        row.pct_change_since_launch = (price - row.launch_price) / row.launch_price * 100.0
    row.max_price_since_launch = max(row.max_price_since_launch or price, price)
    row.min_price_since_launch = min(row.min_price_since_launch or price, price)
    await db.flush()
    return row


async def append_price_point(
    db: AsyncSession,
    symbol: str,
    *,
    price: float,
    pct_change_since_launch: float | None = None,
    market_cap: float | None = None,
    volume_24h: float | None = None,
    liquidity: float | None = None,
    score: float | None = None,
    observed_at: datetime | None = None,
) -> None:
    db.add(
        TokenListingPricePoint(
            symbol=symbol.strip().upper(),
            observed_at=observed_at or datetime.now(UTC),
            price=price,
            pct_change_since_launch=pct_change_since_launch,
            market_cap=market_cap,
            volume_24h=volume_24h,
            liquidity=liquidity,
            score=score,
        )
    )


async def list_price_points(
    db: AsyncSession, symbol: str, *, limit: int = 500
) -> list[TokenListingPricePoint]:
    """Oldest-first series for the detail chart."""
    result = await db.execute(
        sa.select(TokenListingPricePoint)
        .where(TokenListingPricePoint.symbol == symbol.strip().upper())
        .order_by(TokenListingPricePoint.observed_at.desc())
        .limit(limit)
    )
    return list(reversed(result.scalars().all()))


async def list_listings(
    db: AsyncSession,
    *,
    limit: int = 100,
    status: str | None = None,
    grade: str | None = None,
    min_score: float | None = None,
    include_rejected: bool = False,
    include_inactive: bool = False,
    max_age_days: int | None = 90,
) -> list[TokenListing]:
    """The screener list.

    Ordering is the product requirement: **soonest listing first, then score**.
    Upcoming tokens (a launch time still in the future) always sort above
    already-listed ones, nearest first; everything already trading falls back
    to score. Postgres and SQLite both honour the CASE ordering used here.
    """
    query = sa.select(TokenListing)

    if not include_inactive:
        query = query.where(TokenListing.inactive.is_(False))
    if not include_rejected:
        query = query.where(TokenListing.rejected_because.is_(None))
    if status:
        query = query.where(TokenListing.status == status)
    if grade:
        query = query.where(TokenListing.grade == grade)
    if min_score is not None:
        query = query.where(TokenListing.score >= min_score)
    if max_age_days is not None:
        cutoff = datetime.now(UTC) - timedelta(days=max_age_days)
        # Keep anything still upcoming regardless of when we first saw it.
        query = query.where(
            sa.or_(
                TokenListing.last_seen_at >= cutoff,
                TokenListing.listing_at >= datetime.now(UTC),
            )
        )

    now = datetime.now(UTC)
    is_upcoming = sa.and_(TokenListing.listing_at.is_not(None), TokenListing.listing_at > now)

    # An announcement-only row with no price and a listing date already past is
    # a ghost: the title named a ticker we could never match to a tradeable
    # market. It cannot be scored (so `rejected_because` stays NULL and the
    # rejection filter never catches it) and it has nothing to show. A genuinely
    # upcoming listing has no price yet either, which is why this is gated on
    # the date having passed rather than on price alone.
    query = query.where(sa.or_(is_upcoming, TokenListing.current_price.is_not(None)))

    upcoming_first = sa.case((is_upcoming, 0), else_=1)

    query = query.order_by(
        # 1. Everything still to list sorts above everything already trading.
        upcoming_first.asc(),
        # 2. Within upcoming: soonest countdown first. NULL for listed rows,
        #    which are already separated by the key above.
        sa.case((is_upcoming, TokenListing.listing_at), else_=None).asc().nulls_last(),
        # 3. Within already-listed: MOST RECENT first. This is the key that was
        #    missing — without it a listed token has no live countdown, so the
        #    date dropped out of the ordering entirely and score silently took
        #    over. "Sorted by time" has to mean newest listing at the top, not
        #    highest score at the top; score is its own sort option.
        sa.case((sa.not_(is_upcoming), TokenListing.listing_at), else_=None)
        .desc()
        .nulls_last(),
        # 4. Only then score, as the tiebreak between same-day listings.
        TokenListing.score.desc().nulls_last(),
        TokenListing.last_seen_at.desc(),
    ).limit(limit)

    result = await db.execute(query)
    return list(result.scalars().all())


async def mark_inactive(db: AsyncSession, symbols: list[str]) -> int:
    """Flag rows no upstream feed reported this pass. Never deletes."""
    if not symbols:
        return 0
    result = await db.execute(
        sa.update(TokenListing)
        .where(TokenListing.symbol.in_([s.strip().upper() for s in symbols]))
        .where(TokenListing.inactive.is_(False))
        .values(inactive=True)
    )
    return result.rowcount or 0


async def record_alert(
    db: AsyncSession,
    *,
    symbol: str,
    kind: str,
    dedup_key: str,
    message: str,
    delivered: bool,
    delivery_error: str | None = None,
) -> bool:
    """Persist one alert. Returns False when the dedup key already exists,
    which is how the caller knows not to send it."""
    existing = await db.execute(
        sa.select(ListingAlert.id).where(ListingAlert.dedup_key == dedup_key)
    )
    if existing.scalar_one_or_none() is not None:
        return False
    db.add(
        ListingAlert(
            symbol=symbol.strip().upper(),
            kind=kind,
            dedup_key=dedup_key,
            message=message,
            delivered=delivered,
            delivery_error=delivery_error,
        )
    )
    await db.flush()
    return True


async def alert_exists(db: AsyncSession, dedup_key: str) -> bool:
    result = await db.execute(
        sa.select(ListingAlert.id).where(ListingAlert.dedup_key == dedup_key)
    )
    return result.scalar_one_or_none() is not None


async def list_alerts(db: AsyncSession, *, limit: int = 50) -> list[ListingAlert]:
    result = await db.execute(
        sa.select(ListingAlert).order_by(ListingAlert.created_at.desc()).limit(limit)
    )
    return list(result.scalars().all())
