"""Add delivery columns to alerts (Sprint 1 "satu mulut" — one bot, one
delivery loop). Additive only: plain-default columns + one index, so a
running API on the previous revision keeps working during rollout.

Revision ID: a7c3d9e1f204
Revises: e8f7a6b5c4d3
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c3d9e1f204"
down_revision: str | None = "e8f7a6b5c4d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alerts",
        sa.Column(
            "delivery_state", sa.String(length=16), nullable=False, server_default="pending"
        ),
    )
    op.add_column(
        "alerts",
        sa.Column("delivery_attempts", sa.SmallInteger(), nullable=False, server_default="0"),
    )
    op.add_column(
        "alerts",
        sa.Column("source", sa.String(length=32), nullable=False, server_default="market_pulse"),
    )
    op.create_index(
        "alerts_delivery_state_idx", "alerts", ["delivery_state", "created_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("alerts_delivery_state_idx", table_name="alerts")
    op.drop_column("alerts", "source")
    op.drop_column("alerts", "delivery_attempts")
    op.drop_column("alerts", "delivery_state")
