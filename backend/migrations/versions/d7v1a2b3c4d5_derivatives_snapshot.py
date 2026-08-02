"""derivatives_snapshot — append-only Binance USDⓈ-M positioning facts.

Additive only: one new table, one unique constraint, one index and the
immutability trigger. Nothing existing is touched, so an API still running the
previous revision keeps working across the rollout, and the collector that
fills this table ships behind `DERIVATIVES_ENABLED` (default off).

Append-only is enforced in the database, not by convention: any UPDATE or
DELETE raises `derivatives_snapshot is append-only`. A correction is a new row
in the next 5-minute slot — same contract as `signal_events`.

Revision ID: d7v1a2b3c4d5
Revises: s5a1b2c3d4e5
Create Date: 2026-08-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7v1a2b3c4d5"
down_revision: str | None = "s5a1b2c3d4e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Wide enough for USD notionals in the hundreds of billions and small enough
# funding rates to stay exact. numeric, not float8: these are money facts.
_NUM = sa.Numeric(38, 12)


def upgrade() -> None:
    op.create_table(
        "derivatives_snapshot",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=20), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        # Every metric nullable: a feed that failed degrades the read, it does
        # not get back-filled with a zero.
        sa.Column("open_interest", _NUM, nullable=True),
        sa.Column("open_interest_usd", _NUM, nullable=True),
        sa.Column("funding_rate", _NUM, nullable=True),
        sa.Column("long_short_ratio", _NUM, nullable=True),
        sa.Column("top_trader_accounts_ratio", _NUM, nullable=True),
        sa.Column("top_trader_positions_ratio", _NUM, nullable=True),
        sa.Column("taker_buy_volume", _NUM, nullable=True),
        sa.Column("taker_sell_volume", _NUM, nullable=True),
        sa.Column("basis", _NUM, nullable=True),
        sa.Column("premium", _NUM, nullable=True),
        sa.Column("oi_marketcap_ratio", _NUM, nullable=True),
        sa.Column("price", _NUM, nullable=True),
        sa.PrimaryKeyConstraint("id"),
        # The writer floors every timestamp onto the 5-minute grid, so a
        # retried tick collides with itself here and ON CONFLICT DO NOTHING
        # makes the retry free.
        sa.UniqueConstraint("symbol", "timestamp", name="derivatives_snapshot_symbol_ts_key"),
    )
    op.execute(
        "CREATE INDEX derivatives_snapshot_symbol_ts_idx"
        " ON derivatives_snapshot (symbol, timestamp DESC)"
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION derivatives_snapshot_immutable() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'derivatives_snapshot is append-only'; END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER derivatives_snapshot_no_mutate
          BEFORE UPDATE OR DELETE ON derivatives_snapshot
          FOR EACH ROW EXECUTE FUNCTION derivatives_snapshot_immutable();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS derivatives_snapshot_no_mutate ON derivatives_snapshot")
    op.execute("DROP FUNCTION IF EXISTS derivatives_snapshot_immutable()")
    op.execute("DROP INDEX IF EXISTS derivatives_snapshot_symbol_ts_idx")
    op.drop_table("derivatives_snapshot")
