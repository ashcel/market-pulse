"""signal_events — append-only signal facts (Sprint 2 "balik arah",
docs/IMPLEMENTATION-PLAN.md §2.1).

Additive only: one new table, three indexes, and the immutability trigger.
Nothing existing is touched, so an API still running the previous revision
keeps working across the rollout.

Append-only is enforced in the database, not by convention: any UPDATE or
DELETE raises `signal_events is append-only`. Corrections are new events.

Revision ID: b3c1f7a2d90e
Revises: a7c3d9e1f204
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b3c1f7a2d90e"
down_revision: str | None = "a7c3d9e1f204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "signal_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("source_version", sa.String(length=32), nullable=False),
        sa.Column("symbol", sa.String(length=20), nullable=False),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("horizon", sa.String(length=16), nullable=False),
        sa.Column("kind", sa.String(length=48), nullable=False),
        sa.Column("conviction", sa.String(length=16), nullable=True),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "features",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("dedup_key", sa.String(length=255), nullable=False),
        sa.Column(
            "ingested_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("dedup_key", name="signal_events_dedup_key_key"),
    )
    op.execute(
        "CREATE INDEX signal_events_symbol_detected_idx"
        " ON signal_events (symbol, detected_at DESC)"
    )
    op.execute("CREATE INDEX signal_events_detected_idx ON signal_events (detected_at DESC)")
    op.create_index("signal_events_source_idx", "signal_events", ["source", "source_version"])

    op.execute(
        """
        CREATE OR REPLACE FUNCTION signal_events_immutable() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'signal_events is append-only'; END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER signal_events_no_mutate
          BEFORE UPDATE OR DELETE ON signal_events
          FOR EACH ROW EXECUTE FUNCTION signal_events_immutable();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS signal_events_no_mutate ON signal_events")
    op.execute("DROP FUNCTION IF EXISTS signal_events_immutable()")
    op.drop_index("signal_events_source_idx", table_name="signal_events")
    op.execute("DROP INDEX IF EXISTS signal_events_detected_idx")
    op.execute("DROP INDEX IF EXISTS signal_events_symbol_detected_idx")
    op.drop_table("signal_events")
