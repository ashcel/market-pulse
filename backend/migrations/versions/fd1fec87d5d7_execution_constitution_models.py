"""Add Trading Constitution models (M9-T1 / EDR 0020): trading_constitutions,
constitution_audits.

Revision ID: fd1fec87d5d7
Revises: efd333538c73
Create Date: 2026-07-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fd1fec87d5d7"
down_revision: str | None = "efd333538c73"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # trading_constitutions — versioned per-account risk config; insert-only,
    # the current config is the highest `version` row for a user.
    op.create_table(
        "trading_constitutions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("risk_per_trade_percent", sa.Float(), nullable=False),
        sa.Column("daily_loss_limit_percent", sa.Float(), nullable=False),
        sa.Column("weekly_loss_limit_percent", sa.Float(), nullable=False),
        sa.Column("max_leverage", sa.Integer(), nullable=False),
        sa.Column("max_concurrent_positions", sa.Integer(), nullable=False),
        sa.Column("max_correlated_exposure_percent", sa.Float(), nullable=False),
        sa.Column("min_risk_reward", sa.Float(), nullable=False),
        sa.Column("allowed_sessions", sa.JSON(), nullable=False),
        sa.Column("allowed_symbols", sa.JSON(), nullable=False),
        sa.Column("binding_cooldowns", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("trading_constitutions_pkey")),
    )
    op.create_index(
        op.f("trading_constitutions_user_id_idx"),
        "trading_constitutions",
        ["user_id"],
        unique=False,
    )
    op.create_unique_constraint(
        op.f("trading_constitutions_user_id_version_key"),
        "trading_constitutions",
        ["user_id", "version"],
    )

    # constitution_audits — one immutable row per constitution create/edit.
    op.create_table(
        "constitution_audits",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("constitution_id", sa.String(length=36), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(length=20), nullable=False),
        sa.Column("changed_by_user_id", sa.String(length=36), nullable=False),
        sa.Column("before_snapshot", sa.JSON(), nullable=True),
        sa.Column("after_snapshot", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("constitution_audits_pkey")),
    )
    op.create_index(
        op.f("constitution_audits_user_id_idx"),
        "constitution_audits",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("constitution_audits_constitution_id_idx"),
        "constitution_audits",
        ["constitution_id"],
        unique=False,
    )
    op.create_index(
        "constitution_audits_user_id_version_idx",
        "constitution_audits",
        ["user_id", "version"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "constitution_audits_user_id_version_idx", table_name="constitution_audits"
    )
    op.drop_index(
        op.f("constitution_audits_constitution_id_idx"), table_name="constitution_audits"
    )
    op.drop_index(op.f("constitution_audits_user_id_idx"), table_name="constitution_audits")
    op.drop_table("constitution_audits")

    op.drop_constraint(
        op.f("trading_constitutions_user_id_version_key"),
        "trading_constitutions",
        type_="unique",
    )
    op.drop_index(
        op.f("trading_constitutions_user_id_idx"), table_name="trading_constitutions"
    )
    op.drop_table("trading_constitutions")
