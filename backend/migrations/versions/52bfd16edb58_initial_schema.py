"""Baseline: adopt the existing legacy schema (no-op).

The live database (Postgres 5435, `market_pulse`) predates Alembic: the legacy
TanStack app owns its schema via hand-written SQL migrations
(`frontend/src/server/db/migrations/0001..`), covering users, sessions,
invites, and the whole forward-test record (shadow_signal, anticipatory_signal,
eval_log, ...). Those tables and their rows are preserved as-is — the
migration plan forbids drop/recreate.

This revision is therefore a pure stamp point: it creates and drops nothing.
Production was marked with `alembic stamp 52bfd16edb58` and all backend-owned
schema changes build on top of it (see b8dd766d556f onwards).
"""

revision = "52bfd16edb58"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
