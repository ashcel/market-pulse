"""Add persisted trade forensics.

Metrics are stored as the frozen `MetricValue` shape (docs/forensics-definitions.md
§2) in a single JSONB column, so availability and its reason can never be
separated from the value. Rows are write-once per `forensics_version`.

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
Create Date: 2026-07-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "e3f4a5b6c7d8"
down_revision: str | None = "d2e3f4a5b6c7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "trade_forensics",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("binance_trade_id", sa.String(36), nullable=False),
        sa.Column("forensics_version", sa.String(20), nullable=False, server_default="1.0.0"),
        sa.Column("kline_interval", sa.String(10)),
        sa.Column("kline_candles_in_window", sa.Integer()),
        sa.Column("boundary_inflation_bound_pct", sa.Float()),
        sa.Column("metrics", JSONB(), nullable=False, server_default="{}"),
        sa.Column("stop_evidence", sa.String(20), nullable=False, server_default="absent"),
        sa.Column("discipline_breach", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "partial_close_suspected", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("reentry_same_direction", sa.Boolean()),
        sa.Column("reentry_after_loss", sa.Boolean()),
        sa.Column("sizing_mode", sa.String(20)),
        sa.Column("sizing_n", sa.Integer()),
        sa.Column("sizing_excluded", sa.Integer()),
        sa.Column("sizing_partial_close_rows", sa.Integer()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["binance_trade_id"],
            ["binance_trades.id"],
            name=op.f("trade_forensics_binance_trade_id_fkey"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("trade_forensics_pkey")),
        sa.UniqueConstraint(
            "binance_trade_id", name=op.f("trade_forensics_binance_trade_id_key")
        ),
    )
    op.create_index(op.f("trade_forensics_user_id_idx"), "trade_forensics", ["user_id"])


def downgrade() -> None:
    op.drop_index(op.f("trade_forensics_user_id_idx"), table_name="trade_forensics")
    op.drop_table("trade_forensics")
