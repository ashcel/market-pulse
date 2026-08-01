"""Sprint 5 — source_scorecard + signal_events status/context_ref

Revision ID: s5a1b2c3d4e5
Revises: c4d5e6f7a8b9
Create Date: 2026-08-01

Parent is the real head (`c4d5e6f7a8b9`, decision_skip_reason), not
`f1a2b3c4d5e6` as first drafted: `signal_events` is created by
`b3c1f7a2d90e`, which is a *descendant* of f1a2b3c4d5e6, so hanging this
revision there both forked the tree into two heads and put the ADD COLUMNs
before the table existed.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "s5a1b2c3d4e5"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- 1. source_scorecard table ---
    op.create_table(
        "source_scorecard",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("source_version", sa.String(32), nullable=False),
        sa.Column("regime", sa.String(32), nullable=False),
        sa.Column("horizon", sa.String(16), nullable=False),
        sa.Column("window_days", sa.Integer, nullable=False, server_default="30"),
        sa.Column("n", sa.Integer, nullable=False, server_default="0"),
        sa.Column("hit_rate", sa.Double, nullable=True),
        sa.Column("avg_r", sa.Double, nullable=True),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "source_scorecard_lookup_idx",
        "source_scorecard",
        ["source", "source_version", "regime", "horizon"],
    )

    # --- 2. signal_events: additive columns (§2.1 deferred to Sprint 5) ---
    #
    # ADD COLUMN is DDL, not DML: the append-only row trigger on signal_events
    # does not fire, and (PG 11+) the server_default is stored in the catalog
    # rather than rewritten row by row. So existing `quant` rows land on 'live'
    # — the source that already earned it — with no UPDATE anywhere.
    op.add_column(
        "signal_events",
        sa.Column(
            "status",
            sa.String(8),
            nullable=False,
            server_default="live",
        ),
    )
    # context_ref: optional JSONB for regime/context at detection time
    op.add_column(
        "signal_events",
        sa.Column("context_ref", JSONB, nullable=True),
    )
    # Read models serve live rows only; shadow rows are recorded, not surfaced.
    op.create_index("signal_events_status_idx", "signal_events", ["status"])


def downgrade() -> None:
    op.drop_index("signal_events_status_idx", table_name="signal_events")
    op.drop_column("signal_events", "context_ref")
    op.drop_column("signal_events", "status")
    op.drop_index("source_scorecard_lookup_idx", table_name="source_scorecard")
    op.drop_table("source_scorecard")
