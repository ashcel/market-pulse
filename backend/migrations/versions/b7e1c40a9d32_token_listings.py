"""New-listing screener: token_listings, price points, alerts

Revision ID: b7e1c40a9d32
Revises: a1c4e7b20d95
Create Date: 2026-08-15

Additive only — three new tables, no existing table touched, so this is safe
to apply on a live prod DB while the API and worker are running.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "b7e1c40a9d32"
down_revision = "a1c4e7b20d95"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "token_listings",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("symbol", sa.String(24), nullable=False),
        sa.Column("name", sa.String(128), nullable=False, server_default=""),
        sa.Column("chain", sa.String(32), nullable=True),
        sa.Column("contract_address", sa.String(256), nullable=True),
        sa.Column("icon_url", sa.String(512), nullable=True),
        sa.Column("coingecko_id", sa.String(96), nullable=True),
        # venue ladder
        sa.Column("status", sa.String(16), nullable=False, server_default="ALPHA"),
        sa.Column("on_alpha", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("on_spot", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("on_futures", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("spot_pair", sa.String(32), nullable=True),
        sa.Column("futures_pair", sa.String(32), nullable=True),
        sa.Column("alpha_listed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("spot_listed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("futures_listed_at", sa.DateTime(timezone=True), nullable=True),
        # calendar
        sa.Column("listing_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("listing_venue", sa.String(16), nullable=True),
        sa.Column("announced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("announcement_title", sa.String(512), nullable=True),
        sa.Column("announcement_url", sa.String(512), nullable=True),
        sa.Column("seed_tag", sa.Boolean, nullable=False, server_default=sa.false()),
        # price, anchored at launch
        sa.Column("launch_price", sa.Float, nullable=True),
        sa.Column("launch_price_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("launch_price_source", sa.String(24), nullable=True),
        sa.Column("current_price", sa.Float, nullable=True),
        sa.Column("price_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pct_change_since_launch", sa.Float, nullable=True),
        sa.Column("max_price_since_launch", sa.Float, nullable=True),
        sa.Column("min_price_since_launch", sa.Float, nullable=True),
        # market shape
        sa.Column("market_cap", sa.Float, nullable=True),
        sa.Column("fdv", sa.Float, nullable=True),
        sa.Column("liquidity", sa.Float, nullable=True),
        sa.Column("volume_24h", sa.Float, nullable=True),
        sa.Column("percent_change_24h", sa.Float, nullable=True),
        sa.Column("circulating_supply", sa.Float, nullable=True),
        sa.Column("total_supply", sa.Float, nullable=True),
        sa.Column("holders", sa.Integer, nullable=True),
        sa.Column("trade_count_24h", sa.Integer, nullable=True),
        # flags
        sa.Column("airdrop_live", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("tge_live", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("hot_tag", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("alpha_score", sa.Integer, nullable=True),
        sa.Column("mul_point", sa.Integer, nullable=True),
        # screener verdict
        sa.Column("score", sa.Float, nullable=True),
        sa.Column("grade", sa.String(16), nullable=True),
        sa.Column("coverage", sa.Float, nullable=True),
        sa.Column("score_version", sa.String(16), nullable=True),
        sa.Column("scored_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejected_because", sa.String(48), nullable=True),
        sa.Column("score_detail", JSONB, nullable=True),
        # attached reads
        sa.Column("holder_map", JSONB, nullable=True),
        sa.Column("holder_map_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("social_pulse", JSONB, nullable=True),
        sa.Column("social_pulse_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ai_analysis", JSONB, nullable=True),
        sa.Column("ai_analysis_at", sa.DateTime(timezone=True), nullable=True),
        # bookkeeping
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("inactive", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.create_unique_constraint("token_listings_symbol_key", "token_listings", ["symbol"])
    op.create_index(
        "token_listings_listing_at_idx",
        "token_listings",
        [sa.text("listing_at DESC NULLS LAST")],
    )
    op.create_index(
        "token_listings_score_idx", "token_listings", [sa.text("score DESC NULLS LAST")]
    )
    op.create_index("token_listings_status_idx", "token_listings", ["status"])
    op.create_index(
        "token_listings_last_seen_idx", "token_listings", [sa.text("last_seen_at DESC")]
    )

    op.create_table(
        "token_listing_price_points",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("symbol", sa.String(24), nullable=False),
        sa.Column(
            "observed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("price", sa.Float, nullable=False),
        sa.Column("pct_change_since_launch", sa.Float, nullable=True),
        sa.Column("market_cap", sa.Float, nullable=True),
        sa.Column("volume_24h", sa.Float, nullable=True),
        sa.Column("liquidity", sa.Float, nullable=True),
        sa.Column("score", sa.Float, nullable=True),
    )
    op.create_index(
        "token_listing_price_points_symbol_idx",
        "token_listing_price_points",
        ["symbol", sa.text("observed_at DESC")],
    )

    op.create_table(
        "token_listing_alerts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("symbol", sa.String(24), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("dedup_key", sa.String(160), nullable=False),
        sa.Column("message", sa.String(2048), nullable=False),
        sa.Column("delivered", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("delivery_error", sa.String(256), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_unique_constraint(
        "token_listing_alerts_dedup_key_key", "token_listing_alerts", ["dedup_key"]
    )
    op.create_index(
        "token_listing_alerts_sent_idx", "token_listing_alerts", [sa.text("created_at DESC")]
    )


def downgrade() -> None:
    op.drop_table("token_listing_alerts")
    op.drop_table("token_listing_price_points")
    op.drop_table("token_listings")
