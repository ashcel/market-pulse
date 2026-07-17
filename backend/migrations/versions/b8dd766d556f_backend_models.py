"""Add backend models: tokens, signals, trades; extend users table.

Revision ID: b8dd766d556f
Revises: 52bfd16edb58
Create Date: 2026-07-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8dd766d556f"
down_revision: str | None = "52bfd16edb58"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Add hashed_password column to existing users table (nullable so existing rows still work)
    op.add_column(
        "users",
        sa.Column("hashed_password", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )

    # Create tokens table (price reference store for the market API)
    op.create_table(
        "tokens",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=20), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("current_price", sa.Float(), nullable=True),
        sa.Column("market_cap", sa.Float(), nullable=True),
        sa.Column("volume_24h", sa.Float(), nullable=True),
        sa.Column("change_24h", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("tokens_pkey")),
    )
    op.create_index(op.f("tokens_symbol_idx"), "tokens", ["symbol"], unique=True)

    # Create signals table
    op.create_table(
        "signals",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("token_id", sa.String(length=36), nullable=False),
        sa.Column("direction", sa.String(length=10), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("entry_price", sa.Float(), nullable=True),
        sa.Column("target_price", sa.Float(), nullable=True),
        sa.Column("stop_loss", sa.Float(), nullable=True),
        sa.Column("reasoning", sa.Text(), nullable=True),
        sa.Column("strategy", sa.String(length=64), nullable=True),
        sa.Column("timeframe", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("triggered_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("signals_pkey")),
    )
    op.create_index(op.f("signals_token_id_idx"), "signals", ["token_id"], unique=False)

    # Create trades table
    op.create_table(
        "trades",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=20), nullable=False),
        sa.Column("direction", sa.String(length=10), nullable=False),
        sa.Column("entry_price", sa.Float(), nullable=False),
        sa.Column("exit_price", sa.Float(), nullable=True),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("leverage", sa.Integer(), nullable=False),
        sa.Column("pnl", sa.Float(), nullable=True),
        sa.Column("pnl_percent", sa.Float(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("strategy", sa.String(length=64), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("opened_at", sa.DateTime(), nullable=False),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("trades_pkey")),
    )
    op.create_index(op.f("trades_user_id_idx"), "trades", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("trades_user_id_idx"), table_name="trades")
    op.drop_table("trades")
    op.drop_index(op.f("signals_token_id_idx"), table_name="signals")
    op.drop_table("signals")
    op.drop_index(op.f("tokens_symbol_idx"), table_name="tokens")
    op.drop_table("tokens")
    op.drop_column("users", "updated_at")
    op.drop_column("users", "hashed_password")
