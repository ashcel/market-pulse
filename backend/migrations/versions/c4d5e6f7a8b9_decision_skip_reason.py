"""Add the structured reason captured when a Ticket is skipped.

Revision ID: c4d5e6f7a8b9
Revises: b3c1f7a2d90e
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: str | None = "b3c1f7a2d90e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The established decision writer calls this table decision_snapshots;
    # this is the decisions record referred to in the implementation plan.
    op.add_column("decision_snapshots", sa.Column("skip_reason", sa.String(length=24), nullable=True))


def downgrade() -> None:
    op.drop_column("decision_snapshots", "skip_reason")
