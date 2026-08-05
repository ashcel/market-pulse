"""Add durable decision alerts.

Revision ID: d4e5f6a7b8c9
Revises: a4b5c6d7e8f9
Create Date: 2026-07-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: str | None = "a4b5c6d7e8f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "alerts",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("token_symbol", sa.String(20), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_decision_id", sa.String(36), nullable=True),
        sa.Column("dedupe_key", sa.String(255), nullable=False),
        sa.ForeignKeyConstraint(["source_decision_id"], ["trade_permits.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("alerts_pkey")),
        sa.UniqueConstraint("dedupe_key", name="alerts_dedupe_key_key"),
    )
    op.create_index(op.f("alerts_user_id_idx"), "alerts", ["user_id"])
    op.create_index("alerts_user_id_created_at_idx", "alerts", ["user_id", "created_at"])
    op.create_index("alerts_user_id_read_idx", "alerts", ["user_id", "read"])


def downgrade() -> None:
    op.drop_index("alerts_user_id_read_idx", table_name="alerts")
    op.drop_index("alerts_user_id_created_at_idx", table_name="alerts")
    op.drop_index(op.f("alerts_user_id_idx"), table_name="alerts")
    op.drop_table("alerts")
