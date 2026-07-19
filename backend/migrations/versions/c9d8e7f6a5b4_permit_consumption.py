"""Add permit consumption and execution record.

Revision ID: c9d8e7f6a5b4
Revises: a1b2c3d4e5f6
Create Date: 2026-07-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c9d8e7f6a5b4"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("trade_permits", sa.Column("consumed_at", sa.DateTime(), nullable=True))
    op.add_column(
        "trade_permits",
        sa.Column("consumed_by_execution_id", sa.String(length=36), nullable=True),
    )
    op.create_index(
        op.f("trade_permits_consumed_at_idx"),
        "trade_permits",
        ["consumed_at"],
        unique=False,
    )
    op.create_unique_constraint(
        op.f("trade_permits_consumed_by_execution_id_key"),
        "trade_permits",
        ["consumed_by_execution_id"],
    )

    op.create_table(
        "execution_records",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("permit_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=20), nullable=False),
        sa.Column("side", sa.String(length=10), nullable=False),
        sa.Column("entry_type", sa.String(length=20), nullable=False),
        sa.Column("entry_price", sa.Float(), nullable=False),
        sa.Column("stop_price", sa.Float(), nullable=False),
        sa.Column("target_price", sa.Float(), nullable=True),
        sa.Column("leverage", sa.Float(), nullable=False),
        sa.Column("risk_percent", sa.Float(), nullable=False),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("entry_client_order_id", sa.String(length=160), nullable=False),
        sa.Column("sl_client_order_id", sa.String(length=160), nullable=False),
        sa.Column("tp_client_order_id", sa.String(length=160), nullable=True),
        sa.Column("entry_order_id", sa.String(length=80), nullable=True),
        sa.Column("sl_order_id", sa.String(length=80), nullable=True),
        sa.Column("tp_order_id", sa.String(length=80), nullable=True),
        sa.Column("filled_quantity", sa.Float(), nullable=False),
        sa.Column("protected_quantity", sa.Float(), nullable=False),
        sa.Column("flattened", sa.Boolean(), nullable=False),
        sa.Column("retry_count", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("event_log", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("execution_records_pkey")),
        sa.UniqueConstraint(
            "entry_client_order_id", name=op.f("execution_records_entry_client_order_id_key")
        ),
        sa.UniqueConstraint("idempotency_key", name="execution_records_idempotency_key_key"),
        sa.UniqueConstraint("permit_id", name="execution_records_permit_id_key"),
        sa.UniqueConstraint(
            "sl_client_order_id", name=op.f("execution_records_sl_client_order_id_key")
        ),
        sa.UniqueConstraint(
            "tp_client_order_id", name=op.f("execution_records_tp_client_order_id_key")
        ),
    )
    op.create_index(
        op.f("execution_records_permit_id_idx"),
        "execution_records",
        ["permit_id"],
        unique=False,
    )
    op.create_index(
        op.f("execution_records_status_idx"),
        "execution_records",
        ["status"],
        unique=False,
    )
    op.create_index(
        op.f("execution_records_user_id_idx"),
        "execution_records",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "execution_records_user_id_created_at_idx",
        "execution_records",
        ["user_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("execution_records_user_id_created_at_idx", table_name="execution_records")
    op.drop_index(op.f("execution_records_user_id_idx"), table_name="execution_records")
    op.drop_index(op.f("execution_records_status_idx"), table_name="execution_records")
    op.drop_index(op.f("execution_records_permit_id_idx"), table_name="execution_records")
    op.drop_table("execution_records")

    op.drop_constraint(
        op.f("trade_permits_consumed_by_execution_id_key"),
        "trade_permits",
        type_="unique",
    )
    op.drop_index(op.f("trade_permits_consumed_at_idx"), table_name="trade_permits")
    op.drop_column("trade_permits", "consumed_by_execution_id")
    op.drop_column("trade_permits", "consumed_at")
