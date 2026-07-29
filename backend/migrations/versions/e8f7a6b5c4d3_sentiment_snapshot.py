"""Add sentiment_snapshot table for AI-powered news sentiment analysis.

Revision ID: e8f7a6b5c4d3
Revises: d4e5f6a7b8c9
Create Date: 2026-07-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e8f7a6b5c4d3"
down_revision: str | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sentiment_snapshot",
        sa.Column("id", sa.String(length=36), nullable=False),
        # When this analysis batch was computed
        sa.Column("snapshot_at", sa.DateTime(timezone=True), nullable=False),
        # Per-asset sentiments: JSONB map of ticker -> {direction, confidence, reason}
        sa.Column("asset_sentiments", sa.JSON(), nullable=False),
        # Aggregate market sentiment: {score, label, bullish_ratio, bearish_ratio,
        # neutral_ratio, total_headlines, description}
        sa.Column("market_sentiment", sa.JSON(), nullable=False),
        # Key narratives/themes detected in this window
        sa.Column("key_narratives", sa.JSON(), nullable=True),
        # AI-generated brief (2-3 sentence summary)
        sa.Column("ai_brief", sa.Text(), nullable=True),
        # How many headlines were analyzed
        sa.Column("headlines_analyzed", sa.Integer(), nullable=False, server_default=sa.text("0")),
        # Time window of news considered
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("window_end", sa.DateTime(timezone=True), nullable=True),
        # Source classification
        sa.Column("source", sa.String(length=20), nullable=False, server_default="ai"),
        # Model used for analysis
        sa.Column("model", sa.String(length=100), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_sentiment_snapshot_snapshot_at"),
        "sentiment_snapshot",
        ["snapshot_at"],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_sentiment_snapshot_snapshot_at"), table_name="sentiment_snapshot")
    op.drop_table("sentiment_snapshot")
