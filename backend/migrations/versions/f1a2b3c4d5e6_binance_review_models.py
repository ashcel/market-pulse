"""Trade Review: Bybit -> Binance. Drops the Bybit review tables (nothing in
the live app reads them anymore — see app/bybit/ module docstrings), renames
trade_reviews.bybit_trade_id -> binance_trade_id, and adds the Binance
Trade-Review tables: binance_review_keys, binance_trades,
binance_review_sync_logs.

Revision ID: f1a2b3c4d5e6
Revises: c9d8e7f6a5b4
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: str | None = "c9d8e7f6a5b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # --- drop the Bybit review tables (superseded; see app/bybit/) ---------
    op.drop_index("bybit_trades_user_id_closed_at_idx", table_name="bybit_trades")
    op.drop_constraint(
        op.f("bybit_trades_user_id_exchange_trade_id_key"), "bybit_trades", type_="unique"
    )
    op.drop_index(op.f("bybit_trades_symbol_idx"), table_name="bybit_trades")
    op.drop_index(op.f("bybit_trades_user_id_idx"), table_name="bybit_trades")
    op.drop_table("bybit_trades")

    op.drop_index(op.f("bybit_sync_logs_user_id_idx"), table_name="bybit_sync_logs")
    op.drop_table("bybit_sync_logs")

    op.drop_index(op.f("bybit_api_keys_user_id_idx"), table_name="bybit_api_keys")
    op.drop_table("bybit_api_keys")

    # --- rename trade_reviews.bybit_trade_id -> binance_trade_id -----------
    op.drop_index(
        "trade_reviews_bybit_trade_id_version_idx", table_name="trade_reviews"
    )
    op.drop_index(op.f("trade_reviews_bybit_trade_id_idx"), table_name="trade_reviews")
    op.alter_column("trade_reviews", "bybit_trade_id", new_column_name="binance_trade_id")
    op.create_index(
        op.f("trade_reviews_binance_trade_id_idx"),
        "trade_reviews",
        ["binance_trade_id"],
        unique=False,
    )
    op.create_index(
        "trade_reviews_binance_trade_id_version_idx",
        "trade_reviews",
        ["binance_trade_id", "version"],
        unique=False,
    )

    # --- binance_review_keys — one encrypted read-only credential per user -
    op.create_table(
        "binance_review_keys",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("api_key", sa.String(length=255), nullable=False),
        sa.Column("encrypted_secret", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("last_sync_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("binance_review_keys_pkey")),
    )
    op.create_index(
        op.f("binance_review_keys_user_id_idx"), "binance_review_keys", ["user_id"], unique=True
    )

    # --- binance_trades — synced + enriched closed USDT-M futures trades ---
    op.create_table(
        "binance_trades",
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
        sa.Column("raw_income", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("binance_trades_pkey")),
    )
    op.create_index(
        op.f("binance_trades_user_id_idx"), "binance_trades", ["user_id"], unique=False
    )
    op.create_index(
        op.f("binance_trades_symbol_idx"), "binance_trades", ["symbol"], unique=False
    )
    op.create_unique_constraint(
        op.f("binance_trades_user_id_exchange_trade_id_key"),
        "binance_trades",
        ["user_id", "exchange_trade_id"],
    )
    op.create_index(
        "binance_trades_user_id_closed_at_idx",
        "binance_trades",
        ["user_id", "closed_at"],
        unique=False,
    )

    # --- binance_review_sync_logs — one row per sync attempt ---------------
    op.create_table(
        "binance_review_sync_logs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("trades_imported", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("binance_review_sync_logs_pkey")),
    )
    op.create_index(
        op.f("binance_review_sync_logs_user_id_idx"),
        "binance_review_sync_logs",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("binance_review_sync_logs_user_id_idx"), table_name="binance_review_sync_logs"
    )
    op.drop_table("binance_review_sync_logs")

    op.drop_index("binance_trades_user_id_closed_at_idx", table_name="binance_trades")
    op.drop_constraint(
        op.f("binance_trades_user_id_exchange_trade_id_key"), "binance_trades", type_="unique"
    )
    op.drop_index(op.f("binance_trades_symbol_idx"), table_name="binance_trades")
    op.drop_index(op.f("binance_trades_user_id_idx"), table_name="binance_trades")
    op.drop_table("binance_trades")

    op.drop_index(op.f("binance_review_keys_user_id_idx"), table_name="binance_review_keys")
    op.drop_table("binance_review_keys")

    op.drop_index(
        "trade_reviews_binance_trade_id_version_idx", table_name="trade_reviews"
    )
    op.drop_index(op.f("trade_reviews_binance_trade_id_idx"), table_name="trade_reviews")
    op.alter_column("trade_reviews", "binance_trade_id", new_column_name="bybit_trade_id")
    op.create_index(
        op.f("trade_reviews_bybit_trade_id_idx"), "trade_reviews", ["bybit_trade_id"], unique=False
    )
    op.create_index(
        "trade_reviews_bybit_trade_id_version_idx",
        "trade_reviews",
        ["bybit_trade_id", "version"],
        unique=False,
    )

    # --- recreate the dropped Bybit review tables ---------------------------
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
    op.create_index(op.f("bybit_trades_user_id_idx"), "bybit_trades", ["user_id"], unique=False)
    op.create_index(op.f("bybit_trades_symbol_idx"), "bybit_trades", ["symbol"], unique=False)
    op.create_unique_constraint(
        op.f("bybit_trades_user_id_exchange_trade_id_key"),
        "bybit_trades",
        ["user_id", "exchange_trade_id"],
    )
    op.create_index(
        "bybit_trades_user_id_closed_at_idx", "bybit_trades", ["user_id", "closed_at"], unique=False
    )

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
