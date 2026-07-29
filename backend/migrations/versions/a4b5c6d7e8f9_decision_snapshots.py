"""Add decision snapshots.

Revision ID: a4b5c6d7e8f9
Revises: e3f4a5b6c7d8
Create Date: 2026-07-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a4b5c6d7e8f9"
down_revision: str | None = "e3f4a5b6c7d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "decision_snapshots",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("symbol", sa.String(20), nullable=False),
        sa.Column("objective", sa.String(20), nullable=False),
        sa.Column("direction", sa.String(10), nullable=False),
        sa.Column("verdict_at_time", sa.String(50), nullable=False),
        sa.Column("catalyst_modifier", JSONB()),
        sa.Column("skip_check_result", JSONB()),
        sa.Column("entry_zone", JSONB()),
        sa.Column("stop_loss", sa.Float()),
        sa.Column("take_profit", sa.Float()),
        sa.Column("user_action", sa.String(30)),
        sa.Column("actual_outcome", JSONB()),
        sa.Column("engine_version", sa.String(50), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("decided_at", sa.DateTime()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("decision_snapshots_user_id_fkey"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("decision_snapshots_pkey")),
    )
    op.create_index(op.f("decision_snapshots_user_id_idx"), "decision_snapshots", ["user_id"])
    op.create_index(op.f("decision_snapshots_symbol_idx"), "decision_snapshots", ["symbol"])
    op.create_index(op.f("decision_snapshots_user_action_idx"), "decision_snapshots", ["user_action"])
    op.create_index("decision_snapshots_user_id_created_at_idx", "decision_snapshots", ["user_id", "created_at"])
    op.create_index("decision_snapshots_user_id_action_idx", "decision_snapshots", ["user_id", "user_action"])


def downgrade() -> None:
    op.drop_table("decision_snapshots")
