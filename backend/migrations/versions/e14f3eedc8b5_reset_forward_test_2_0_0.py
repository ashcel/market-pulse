"""Reset the forward-test plane for engine 2.0.0 (Phase 4 worker cutover).

Owner decision 2026-07-17: the 1.0.0 TS record was buggy and never really
recorded — it is disposable. This revision drops the legacy forward-test
tables (data and all) and recreates them backend-owned with **identical
shapes**, so the legacy web app's read models keep working while the Python
arq worker becomes the sole writer under ENGINE_VERSION 2.0.0.

Also truncates tracked_signal (1.0.0 follows are graded by a dead engine) —
the table itself is preserved: the legacy web app still writes follows and
reads them back.

Irreversible by design: downgrade cannot restore the dropped record.

Revision ID: e14f3eedc8b5
Revises: b8dd766d556f
Create Date: 2026-07-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "e14f3eedc8b5"
down_revision: str | None = "b8dd766d556f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Drop children before engine_run (they FK it).
    op.drop_table("eval_log")
    op.drop_table("shadow_signal")
    op.drop_table("anticipatory_signal")
    op.drop_table("engine_run")
    op.drop_table("verdict_hold")
    op.execute("truncate table tracked_signal")

    op.create_table(
        "engine_run",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("engine_version", sa.Text(), nullable=False),
        sa.Column("config_hash", sa.Text(), nullable=False),
        sa.Column("git_sha", sa.Text(), nullable=False),
        sa.Column("universe_json", JSONB(), nullable=True),
        sa.Column("status", sa.Text(), server_default=sa.text("'ok'::text"), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("engine_run_pkey")),
    )

    op.create_table(
        "eval_log",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("engine_run_id", UUID(as_uuid=False), nullable=True),
        sa.Column(
            "evaluated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("symbol", sa.Text(), nullable=False),
        sa.Column("market", sa.Text(), nullable=False),
        sa.Column("intent", sa.Text(), nullable=False),
        sa.Column("verdict", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=True),
        sa.Column("setup_type", sa.Text(), nullable=False),
        sa.Column("regime", sa.Text(), nullable=False),
        sa.Column("timeframe", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Double(), nullable=True),
        sa.Column("bt_win_rate", sa.Double(), nullable=True),
        sa.Column("bt_expectancy", sa.Double(), nullable=True),
        sa.Column("bt_avg_r", sa.Double(), nullable=True),
        sa.Column("bt_total_trades", sa.Integer(), nullable=True),
        sa.Column("bt_low_sample", sa.Boolean(), nullable=True),
        sa.Column("no_trade_reasons", JSONB(), nullable=True),
        sa.Column("component_scores", JSONB(), nullable=True),
        sa.Column("engine_version", sa.Text(), nullable=False),
        sa.Column("config_hash", sa.Text(), nullable=False),
        sa.Column("git_sha", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["engine_run_id"], ["engine_run.id"], name=op.f("eval_log_engine_run_id_fkey")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("eval_log_pkey")),
    )
    op.create_index("eval_log_verdict_idx", "eval_log", ["verdict"])
    op.create_index(
        "eval_log_lookup_idx", "eval_log", ["symbol", "market", "intent", "evaluated_at"]
    )
    op.create_index("eval_log_bt_idx", "eval_log", ["bt_win_rate", "bt_total_trades"])

    op.create_table(
        "shadow_signal",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("symbol", sa.Text(), nullable=False),
        sa.Column("market", sa.Text(), nullable=False),
        sa.Column("intent", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("setup_type", sa.Text(), nullable=False),
        sa.Column("regime", sa.Text(), nullable=False),
        sa.Column("timeframe", sa.Text(), nullable=False),
        sa.Column("entry", sa.Double(), nullable=False),
        sa.Column("stop", sa.Double(), nullable=False),
        sa.Column("target1", sa.Double(), nullable=False),
        sa.Column("target2", sa.Double(), nullable=False),
        sa.Column("confidence", sa.Double(), nullable=False),
        sa.Column("objective_resolved", sa.Boolean(), nullable=True),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'active'::text"), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("close_price", sa.Double(), nullable=True),
        sa.Column("result_r", sa.Double(), nullable=True),
        sa.Column("engine_version", sa.Text(), nullable=False),
        sa.Column("config_hash", sa.Text(), nullable=False),
        sa.Column("git_sha", sa.Text(), nullable=False),
        sa.Column("engine_run_id", UUID(as_uuid=False), nullable=True),
        sa.ForeignKeyConstraint(
            ["engine_run_id"], ["engine_run.id"], name=op.f("shadow_signal_engine_run_id_fkey")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("shadow_signal_pkey")),
    )
    op.create_index("shadow_open_idx", "shadow_signal", ["status"])
    op.create_index("shadow_group_idx", "shadow_signal", ["symbol", "timeframe", "market"])
    op.create_index(
        "shadow_combo_idx", "shadow_signal", ["engine_version", "setup_type", "regime"]
    )
    op.create_index(
        "shadow_active_uniq",
        "shadow_signal",
        ["symbol", "market", "intent"],
        unique=True,
        postgresql_where=sa.text("status = 'active'::text"),
    )

    op.create_table(
        "anticipatory_signal",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("symbol", sa.Text(), nullable=False),
        sa.Column("market", sa.Text(), nullable=False),
        sa.Column("intent", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("setup_type", sa.Text(), nullable=False),
        sa.Column("regime", sa.Text(), nullable=False),
        sa.Column("timeframe", sa.Text(), nullable=False),
        sa.Column("verdict", sa.Text(), nullable=False),
        sa.Column("entry", sa.Double(), nullable=False),
        sa.Column("stop", sa.Double(), nullable=False),
        sa.Column("objective", sa.Double(), nullable=False),
        sa.Column("objective_strength", sa.Text(), nullable=False),
        sa.Column("zone_freshness", sa.Text(), nullable=False),
        sa.Column("reward_risk", sa.Double(), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "status", sa.Text(), server_default=sa.text("'pending'::text"), nullable=False
        ),
        sa.Column("filled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("close_price", sa.Double(), nullable=True),
        sa.Column("result_r", sa.Double(), nullable=True),
        sa.Column("engine_version", sa.Text(), nullable=False),
        sa.Column("config_hash", sa.Text(), nullable=False),
        sa.Column("git_sha", sa.Text(), nullable=False),
        sa.Column("engine_run_id", UUID(as_uuid=False), nullable=True),
        sa.ForeignKeyConstraint(
            ["engine_run_id"],
            ["engine_run.id"],
            name=op.f("anticipatory_signal_engine_run_id_fkey"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("anticipatory_signal_pkey")),
    )
    op.create_index("anticipatory_open_idx", "anticipatory_signal", ["status"])
    op.create_index(
        "anticipatory_group_idx", "anticipatory_signal", ["symbol", "timeframe", "market"]
    )
    op.create_index(
        "anticipatory_active_uniq",
        "anticipatory_signal",
        ["symbol", "market", "intent"],
        unique=True,
        postgresql_where=sa.text("status = ANY (ARRAY['pending'::text, 'filled'::text])"),
    )

    op.create_table(
        "verdict_hold",
        sa.Column("hold_key", sa.Text(), nullable=False),
        sa.Column("symbol", sa.Text(), nullable=False),
        sa.Column("market", sa.Text(), nullable=False),
        sa.Column("data", JSONB(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("hold_key", name=op.f("verdict_hold_pkey")),
    )
    op.create_index("verdict_hold_scope_idx", "verdict_hold", ["symbol", "market"])


def downgrade() -> None:
    raise RuntimeError(
        "The 2.0.0 forward-test reset is irreversible — the dropped 1.0.0 record "
        "cannot be restored by a schema migration."
    )
