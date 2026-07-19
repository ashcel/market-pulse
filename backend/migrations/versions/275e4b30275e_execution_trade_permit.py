"""Add Trade Permit model (M9-T5 / EDR 0020 decision 6): trade_permits.

This table is intentionally **insert-only**: the application layer
(`app.execution.permit_service`) exposes no update/mutate function for
permit rows (see that module's docstring + `models.TradePermit`'s
docstring + `tests/test_execution_permit.py::test_no_update_path_exists`).
A DB-level `REVOKE UPDATE` grant would harden this further but is
intentionally **not** added by this migration — this migration is
hand-written and is never executed by the task that authored it (this
VPS's `DATABASE_URL` is the live database; alembic upgrade/downgrade is
off-limits per CLAUDE.md). Whoever runs this migration for real should
consider adding that grant at that time; this comment documents the
intent so it isn't lost.

Revision ID: 275e4b30275e
Revises: fd1fec87d5d7
Create Date: 2026-07-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "275e4b30275e"
down_revision: str | None = "fd1fec87d5d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "trade_permits",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=20), nullable=False),
        sa.Column("side", sa.String(length=10), nullable=False),
        sa.Column("proposal_snapshot", sa.JSON(), nullable=False),
        sa.Column("account_state_snapshot", sa.JSON(), nullable=False),
        sa.Column("check_results", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("reasons", sa.JSON(), nullable=False),
        sa.Column("quality_score", sa.Float(), nullable=False),
        sa.Column("quality_components", sa.JSON(), nullable=False),
        sa.Column("quality_disclaimer", sa.String(length=255), nullable=False),
        sa.Column("evaluated_at", sa.DateTime(), nullable=False),
        sa.Column("session", sa.String(length=20), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("trade_permits_pkey")),
    )
    op.create_index(
        op.f("trade_permits_user_id_idx"), "trade_permits", ["user_id"], unique=False
    )
    op.create_index(
        op.f("trade_permits_symbol_idx"), "trade_permits", ["symbol"], unique=False
    )
    op.create_index(
        op.f("trade_permits_status_idx"), "trade_permits", ["status"], unique=False
    )
    op.create_index(
        op.f("trade_permits_expires_at_idx"), "trade_permits", ["expires_at"], unique=False
    )
    op.create_index(
        "trade_permits_user_id_created_at_idx",
        "trade_permits",
        ["user_id", "created_at"],
        unique=False,
    )

    # No UPDATE-blocking trigger/grant is created here — see this file's
    # module docstring for why, and where that decision is documented.


def downgrade() -> None:
    op.drop_index(
        "trade_permits_user_id_created_at_idx", table_name="trade_permits"
    )
    op.drop_index(op.f("trade_permits_expires_at_idx"), table_name="trade_permits")
    op.drop_index(op.f("trade_permits_status_idx"), table_name="trade_permits")
    op.drop_index(op.f("trade_permits_symbol_idx"), table_name="trade_permits")
    op.drop_index(op.f("trade_permits_user_id_idx"), table_name="trade_permits")
    op.drop_table("trade_permits")
