"""Sprint 5 — source_scorecard + signal_events status/context_ref

Revision ID: s5a1b2c3d4e5
Revises: f1a2b3c4d5e6
Create Date: 2026-08-01
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "s5a1b2c3d4e5"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- 1. source_scorecard table ---
    op.create_table(
        "source_scorecard",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("source_version", sa.String(32), nullable=False),
        sa.Column("regime", sa.String(32), nullable=False),
        sa.Column("horizon", sa.String(16), nullable=False),
        sa.Column("window_days", sa.Integer, nullable=False, server_default="30"),
        sa.Column("n", sa.Integer, nullable=False, server_default="0"),
        sa.Column("hit_rate", sa.Double, nullable=True),
        sa.Column("avg_r", sa.Double, nullable=True),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "source_scorecard_lookup_idx",
        "source_scorecard",
        ["source", "source_version", "regime", "horizon"],
    )

    # --- 2. signal_events: additive columns (§2.1 deferred to Sprint 5) ---
    # status: new sources default 'shadow'; existing quant data stays 'live'
    op.add_column(
        "signal_events",
        sa.Column(
            "status",
            sa.String(8),
            nullable=False,
            server_default="live",
        ),
    )
    # context_ref: optional JSONB for regime/context at detection time
    op.add_column(
        "signal_events",
        sa.Column("context_ref", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("signal_events", "context_ref")
    op.drop_column("signal_events", "status")
    op.drop_index("source_scorecard_lookup_idx")
    op.drop_table("source_scorecard")
