"""forward_return — the evidence plane's ground truth (V1-T1, EDR 0024).

Additive only: one new table, one unique constraint, two indexes and the
immutability trigger. Nothing existing is touched, so an API still running the
previous revision keeps working across the rollout, and no reader exists yet —
the IC statistics that consume this land in V1-T3/T4.

Append-only is enforced in the database, not by convention: any UPDATE or
DELETE raises `forward_return is append-only`. Recomputation is free and
harmless because the inputs are closed bars, so the unique key absorbs retries
and a redefinition writes a new `version` cohort instead of rewriting history.
A mutable ground truth is how a track record quietly becomes a backtest.

Revision ID: e1f2a3b4c5d6
Revises: d7v1a2b3c4d5
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: str | None = "d7v1a2b3c4d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# numeric, not float8 — a return that drifts in the twelfth decimal changes a
# rank, and ranks are the entire measurement.
_NUM = sa.Numeric(38, 12)


def upgrade() -> None:
    op.create_table(
        "forward_return",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=20), nullable=False),
        # Close time of the anchor bar; the measured window is strictly after
        # this instant.
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("horizon", sa.String(length=8), nullable=False),
        sa.Column("horizon_bars", sa.Integer(), nullable=False),
        sa.Column("interval", sa.String(length=8), nullable=False),
        sa.Column("base_close", _NUM, nullable=False),
        sa.Column("forward_close", _NUM, nullable=False),
        sa.Column("forward_return", _NUM, nullable=False),
        sa.Column("version", sa.String(length=16), nullable=False),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "symbol",
            "observed_at",
            "horizon",
            "version",
            name="forward_return_symbol_observed_horizon_version_key",
        ),
    )
    # The IC pass reads one horizon across a date window for many symbols;
    # the token page reads one symbol across horizons.
    op.execute(
        "CREATE INDEX forward_return_horizon_observed_idx"
        " ON forward_return (horizon, observed_at DESC)"
    )
    op.execute(
        "CREATE INDEX forward_return_symbol_observed_idx"
        " ON forward_return (symbol, observed_at DESC)"
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION forward_return_immutable() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forward_return is append-only'; END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER forward_return_no_mutate
          BEFORE UPDATE OR DELETE ON forward_return
          FOR EACH ROW EXECUTE FUNCTION forward_return_immutable();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS forward_return_no_mutate ON forward_return")
    op.execute("DROP FUNCTION IF EXISTS forward_return_immutable()")
    op.execute("DROP INDEX IF EXISTS forward_return_symbol_observed_idx")
    op.execute("DROP INDEX IF EXISTS forward_return_horizon_observed_idx")
    op.drop_table("forward_return")
