"""`token_listings` + `token_listing_price_points` — the durable record of
every new Binance listing the screener has ever seen.

Two properties drive the whole shape of these tables:

**Rows are never deleted.** A token that falls out of the Alpha feed, gets
delisted, or simply goes quiet keeps its row forever. The screener's list
view filters by recency; the *record* keeps everything, because the only way
to ever answer "does a high score at listing predict anything?" is to still
have the losers.

**`launch_price` is written once.** It is the open of the first traded minute
(or the first price ever observed, when no exchange kline exists), and every
subsequent pass updates `current_price` and re-derives
`pct_change_since_launch` against that frozen anchor. A launch price that
drifted with the market would make the whole since-listing column a lie, so
the repo refuses to overwrite a non-null value.

`token_listing_price_points` is the append-only series behind the detail
page's since-launch chart — one row per pass per token, coarse by design.
"""

import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy import Boolean, DateTime, Float, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# JSONB on Postgres (the only place this ships), plain JSON under the sqlite
# the unit tests use.
PayloadJSON = sa.JSON().with_variant(JSONB, "postgresql")


class TokenListing(Base):
    """One token, one row, for its whole life."""

    __tablename__ = "token_listings"
    __table_args__ = (
        sa.UniqueConstraint("symbol", name="token_listings_symbol_key"),
        sa.Index("token_listings_listing_at_idx", sa.text("listing_at DESC NULLS LAST")),
        sa.Index("token_listings_score_idx", sa.text("score DESC NULLS LAST")),
        sa.Index("token_listings_status_idx", "status"),
        sa.Index("token_listings_last_seen_idx", sa.text("last_seen_at DESC")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # Base asset, e.g. "KII". The natural key — Binance does not reuse them
    # across live listings.
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    chain: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Wide: a Sui address is type-qualified (`0x…::module::TYPE`) and runs
    # well past the 42 chars an EVM address needs.
    contract_address: Mapped[str | None] = mapped_column(String(256), nullable=True)
    icon_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    coingecko_id: Mapped[str | None] = mapped_column(String(96), nullable=True)

    # ── venue ladder ────────────────────────────────────────────────────────
    # 'UPCOMING' | 'ALPHA' | 'SPOT' | 'FUTURES' — the furthest rung reached.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ALPHA")
    on_alpha: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    on_spot: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    on_futures: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    spot_pair: Mapped[str | None] = mapped_column(String(32), nullable=True)
    futures_pair: Mapped[str | None] = mapped_column(String(32), nullable=True)
    alpha_listed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    spot_listed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    futures_listed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ── calendar ────────────────────────────────────────────────────────────
    # The scheduled launch that sorts the list. Future = upcoming.
    listing_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    listing_venue: Mapped[str | None] = mapped_column(String(16), nullable=True)
    announced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    announcement_title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    announcement_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    seed_tag: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ── price, anchored at launch ───────────────────────────────────────────
    # Written once, then never again. See the module docstring.
    launch_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    launch_price_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 'kline_open' (authoritative) | 'first_observed' (best available)
    launch_price_source: Mapped[str | None] = mapped_column(String(24), nullable=True)
    current_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    pct_change_since_launch: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Running extremes since launch — the honest read on "could I have sold it"
    # that a bare since-launch percentage hides.
    max_price_since_launch: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_price_since_launch: Mapped[float | None] = mapped_column(Float, nullable=True)

    # ── market shape ────────────────────────────────────────────────────────
    market_cap: Mapped[float | None] = mapped_column(Float, nullable=True)
    fdv: Mapped[float | None] = mapped_column(Float, nullable=True)
    liquidity: Mapped[float | None] = mapped_column(Float, nullable=True)
    volume_24h: Mapped[float | None] = mapped_column(Float, nullable=True)
    percent_change_24h: Mapped[float | None] = mapped_column(Float, nullable=True)
    circulating_supply: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_supply: Mapped[float | None] = mapped_column(Float, nullable=True)
    holders: Mapped[int | None] = mapped_column(Integer, nullable=True)
    trade_count_24h: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # ── flags ───────────────────────────────────────────────────────────────
    airdrop_live: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tge_live: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    hot_tag: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    alpha_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mul_point: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # ── screener verdict ────────────────────────────────────────────────────
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    grade: Mapped[str | None] = mapped_column(String(16), nullable=True)
    coverage: Mapped[float | None] = mapped_column(Float, nullable=True)
    score_version: Mapped[str | None] = mapped_column(String(16), nullable=True)
    scored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejected_because: Mapped[str | None] = mapped_column(String(48), nullable=True)
    # Component breakdown, evidence lines and warnings, exactly as the pure
    # scorer produced them — the UI renders these verbatim.
    score_detail: Mapped[dict | None] = mapped_column(PayloadJSON, nullable=True)

    # ── attached reads ──────────────────────────────────────────────────────
    holder_map: Mapped[dict | None] = mapped_column(PayloadJSON, nullable=True)
    holder_map_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    social_pulse: Mapped[dict | None] = mapped_column(PayloadJSON, nullable=True)
    social_pulse_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ai_analysis: Mapped[dict | None] = mapped_column(PayloadJSON, nullable=True)
    ai_analysis_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # ── bookkeeping ─────────────────────────────────────────────────────────
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    # Set when the token stops appearing in any upstream feed. The row stays.
    inactive: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class TokenListingPricePoint(Base):
    """Append-only price series since launch, one row per pass per token."""

    __tablename__ = "token_listing_price_points"
    __table_args__ = (
        sa.Index("token_listing_price_points_symbol_idx", "symbol", sa.text("observed_at DESC")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    price: Mapped[float] = mapped_column(Float, nullable=False)
    pct_change_since_launch: Mapped[float | None] = mapped_column(Float, nullable=True)
    market_cap: Mapped[float | None] = mapped_column(Float, nullable=True)
    volume_24h: Mapped[float | None] = mapped_column(Float, nullable=True)
    liquidity: Mapped[float | None] = mapped_column(Float, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)


class ListingAlert(Base):
    """One delivered (or attempted) alert, so the same event is never sent
    twice — the dedup key is the whole point of persisting these."""

    __tablename__ = "token_listing_alerts"
    __table_args__ = (
        sa.UniqueConstraint("dedup_key", name="token_listing_alerts_dedup_key_key"),
        sa.Index("token_listing_alerts_sent_idx", sa.text("created_at DESC")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    # 'listing_soon' | 'listed' | 'score_upgrade' | 'grade_priority'
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    dedup_key: Mapped[str] = mapped_column(String(160), nullable=False)
    message: Mapped[str] = mapped_column(String(2048), nullable=False)
    delivered: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    delivery_error: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
