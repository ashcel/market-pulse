"""Add live-only append-only position-context stamps.

One row per position episode `(user_id, symbol, side, first_seen_at)`, written
on first observation of a live position (docs/forensics-definitions.md §8).
There is no FK to `binance_trades`: that table holds closed trades and a stamp
must never be constructed from one.

Revision ID: d2e3f4a5b6c7
Revises: f1a2b3c4d5e6
Create Date: 2026-07-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "d2e3f4a5b6c7"
down_revision: str | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "trade_contexts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=30), nullable=False),
        sa.Column("side", sa.String(length=10), nullable=False),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("stamped_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observation_source", sa.String(length=20), nullable=False),
        sa.Column("observation_lag_bound_seconds", sa.Integer(), nullable=False),
        sa.Column("supersedes_id", sa.String(length=36), nullable=True),
        sa.Column("regime", sa.String(length=50), nullable=True),
        sa.Column("verdicts_at_open", JSONB(), nullable=True),
        sa.Column("verdict_source", sa.String(length=20), nullable=False),
        sa.Column("eval_log_id", sa.String(length=36), nullable=True),
        sa.Column("eval_evaluated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("eval_staleness_seconds", sa.Float(), nullable=True),
        sa.Column("engine_version", sa.String(length=20), nullable=True),
        sa.Column("config_hash", sa.String(length=64), nullable=True),
        sa.Column("git_sha", sa.String(length=64), nullable=True),
        sa.Column("session", sa.String(length=20), nullable=False),
        sa.Column("catalysts", JSONB(), nullable=False, server_default="[]"),
        sa.Column("catalyst_top", JSONB(), nullable=True),
        sa.Column("forensics_version", sa.String(length=20), nullable=False),
        sa.Column("impact_score_version", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["supersedes_id"], ["trade_contexts.id"], name=op.f("trade_contexts_supersedes_id_fkey")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("trade_contexts_pkey")),
        sa.UniqueConstraint(
            "user_id", "symbol", "side", "first_seen_at", name="trade_contexts_episode_key"
        ),
    )
    op.create_index(op.f("trade_contexts_user_id_idx"), "trade_contexts", ["user_id"])
    op.create_index(op.f("trade_contexts_symbol_idx"), "trade_contexts", ["symbol"])
    op.create_index(
        "trade_contexts_open_episode_idx",
        "trade_contexts",
        ["user_id", "symbol", "side", "last_seen_at"],
    )


def downgrade() -> None:
    op.drop_index("trade_contexts_open_episode_idx", table_name="trade_contexts")
    op.drop_index(op.f("trade_contexts_symbol_idx"), table_name="trade_contexts")
    op.drop_index(op.f("trade_contexts_user_id_idx"), table_name="trade_contexts")
    op.drop_table("trade_contexts")
