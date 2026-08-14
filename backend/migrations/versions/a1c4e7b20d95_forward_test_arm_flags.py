"""Forward test: detector-arm eligibility, frozen at detection.

Additive and observational, like `regime` before it. A detector arm (`smc.arms`)
changes which setups would exist at all, so unlike an exit or plan arm it cannot
be settled forward without running a second detector. Instead its predicate runs
once, at detection, and the verdict is stamped here; the weekly report reads the
arm as a subset of the same population.

Existing rows stay NULL. NULL means "recorded before the arm existed", which is
not the same as "the arm said no" — the report drops NULL rows from an arm's
comparison rather than counting them as rejections, and conflating the two would
fabricate a rejection rate.
"""

revision = "a1c4e7b20d95"
down_revision = "f5c2a7d81b93"
branch_labels = None
depends_on = None


import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB


def upgrade() -> None:
    op.add_column(
        "forward_test_setups",
        sa.Column("arm_flags", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("forward_test_setups", "arm_flags")
