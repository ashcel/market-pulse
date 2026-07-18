"""Add Bybit Trade Review models: bybit_api_keys, bybit_trades,
bybit_sync_logs, trade_reviews.

Revision ID: efd333538c73
Revises: e14f3eedc8b5
Create Date: 2026-07-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "efd333538c73"
down_revision: str | None = "e14f3eedc8b5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # bybit_api_keys — one encrypted credential pair per user
    op.create_table(
        "bybit_api_keys",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("api_key", sa.String(length=255), nullable=False),
        sa.Column("encrypted_secret", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("last_sync_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("bybit_api_keys_pkey")),
    )
    op.create_index(
        op.f("bybit_api_keys_user_id_idx"), "bybit_api_keys", ["user_id"], unique=True
    )

    # bybit_trades — synced + enriched closed-PnL linear-perp trades
    op.create_table(
        "bybit_trades",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("exchange_trade_id", sa.String(length=100), nullable=False),
        sa.Column("symbol", sa.String(length=20), nullable=False),
        sa.Column("side", sa.String(length=10), nullable=False),
        sa.Column("leverage", sa.Float(), nullable=False),
        sa.Column("entry_price", sa.Float(), nullable=False),
        sa.Column("exit_price", sa.Float(), nullable=False),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("realized_pnl", sa.Float(), nullable=False),
        sa.Column("roi_percent", sa.Float(), nullable=True),
        sa.Column("fees", sa.Float(), nullable=False),
        sa.Column("opened_at", sa.DateTime(), nullable=False),
        sa.Column("open_time_source", sa.String(length=20), nullable=False),
        sa.Column("closed_at", sa.DateTime(), nullable=False),
        sa.Column("stop_loss", sa.Float(), nullable=True),
        sa.Column("take_profit", sa.Float(), nullable=True),
        sa.Column("close_trigger", sa.String(length=20), nullable=True),
        sa.Column("sl_slippage", sa.Float(), nullable=True),
        sa.Column("tp_slippage", sa.Float(), nullable=True),
        sa.Column("raw_close_pnl", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("bybit_trades_pkey")),
    )
    op.create_index(
        op.f("bybit_trades_user_id_idx"), "bybit_trades", ["user_id"], unique=False
    )
    op.create_index(
        op.f("bybit_trades_symbol_idx"), "bybit_trades", ["symbol"], unique=False
    )
    op.create_unique_constraint(
        op.f("bybit_trades_user_id_exchange_trade_id_key"),
        "bybit_trades",
        ["user_id", "exchange_trade_id"],
    )
    op.create_index(
        "bybit_trades_user_id_closed_at_idx",
        "bybit_trades",
        ["user_id", "closed_at"],
        unique=False,
    )

    # bybit_sync_logs — one row per sync attempt
    op.create_table(
        "bybit_sync_logs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("trades_imported", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("bybit_sync_logs_pkey")),
    )
    op.create_index(
        op.f("bybit_sync_logs_user_id_idx"), "bybit_sync_logs", ["user_id"], unique=False
    )

    # trade_reviews — client-generated AI review JSON, persisted verbatim
    op.create_table(
        "trade_reviews",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("bybit_trade_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("review_mode", sa.String(length=20), nullable=False),
        sa.Column("severity_score", sa.Integer(), nullable=False),
        sa.Column("severity_tier", sa.String(length=20), nullable=False),
        sa.Column("grade", sa.String(length=5), nullable=True),
        sa.Column("one_liner", sa.Text(), nullable=True),
        sa.Column("full_review", sa.JSON(), nullable=False),
        sa.Column("model_used", sa.String(length=100), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("generated_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("trade_reviews_pkey")),
    )
    op.create_index(
        op.f("trade_reviews_bybit_trade_id_idx"),
        "trade_reviews",
        ["bybit_trade_id"],
        unique=False,
    )
    op.create_index(
        op.f("trade_reviews_user_id_idx"), "trade_reviews", ["user_id"], unique=False
    )
    op.create_index(
        "trade_reviews_bybit_trade_id_version_idx",
        "trade_reviews",
        ["bybit_trade_id", "version"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("trade_reviews_bybit_trade_id_version_idx", table_name="trade_reviews")
    op.drop_index(op.f("trade_reviews_user_id_idx"), table_name="trade_reviews")
    op.drop_index(op.f("trade_reviews_bybit_trade_id_idx"), table_name="trade_reviews")
    op.drop_table("trade_reviews")

    op.drop_index(op.f("bybit_sync_logs_user_id_idx"), table_name="bybit_sync_logs")
    op.drop_table("bybit_sync_logs")

    op.drop_index("bybit_trades_user_id_closed_at_idx", table_name="bybit_trades")
    op.drop_constraint(
        op.f("bybit_trades_user_id_exchange_trade_id_key"), "bybit_trades", type_="unique"
    )
    op.drop_index(op.f("bybit_trades_symbol_idx"), table_name="bybit_trades")
    op.drop_index(op.f("bybit_trades_user_id_idx"), table_name="bybit_trades")
    op.drop_table("bybit_trades")

    op.drop_index(op.f("bybit_api_keys_user_id_idx"), table_name="bybit_api_keys")
    op.drop_table("bybit_api_keys")
