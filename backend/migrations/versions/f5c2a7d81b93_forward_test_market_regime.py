"""Forward test: whole-market regime at detection and at settlement.

Purely additive and observational — nothing reads these to make a decision.
They exist because two cohorts were compared and the difference between them
turned out to be the tape rather than the detector, which the record had no way
to show. `regime` is frozen at detection; `exit_regime` is written once, at
settlement. Existing rows stay NULL: unknown is a read, NULL is the absence of
one, and conflating them would fabricate history.
"""

revision = "f5c2a7d81b93"
down_revision = "e4b8c1d92f07"
branch_labels = None
depends_on = None


import sqlalchemy as sa
from alembic import op


def upgrade() -> None:
    op.add_column("forward_test_setups", sa.Column("regime", sa.Text(), nullable=True))
    op.add_column("forward_test_setups", sa.Column("exit_regime", sa.Text(), nullable=True))
    op.create_index(
        "forward_test_setups_regime_idx", "forward_test_setups", ["regime", "mode"]
    )


def downgrade() -> None:
    op.drop_index("forward_test_setups_regime_idx", table_name="forward_test_setups")
    op.drop_column("forward_test_setups", "exit_regime")
    op.drop_column("forward_test_setups", "regime")
