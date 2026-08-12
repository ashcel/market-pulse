"""Forward test: net-of-cost results and parallel exit-rule variants.

Adds the columns generation 3 needs. Purely additive: `gross_r` / `cost_r`
split what was previously one gross number, and `variants` records what
alternative exit rules would have produced on the same setup — the controlled
way to answer an exit question without hindsight.
"""

revision = "e4b8c1d92f07"
down_revision = "d7f1c2a9b304"
branch_labels = None
depends_on = None


import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


def upgrade() -> None:
    op.add_column(
        "forward_test_setups",
        sa.Column("gross_r", sa.Double(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "forward_test_setups",
        sa.Column("cost_r", sa.Double(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "forward_test_setups",
        sa.Column("variants", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("forward_test_setups", "variants")
    op.drop_column("forward_test_setups", "cost_r")
    op.drop_column("forward_test_setups", "gross_r")
