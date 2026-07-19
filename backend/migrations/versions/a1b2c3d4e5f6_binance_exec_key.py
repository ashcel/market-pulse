
"""Add BinanceExecKey table.

Revision ID: a1b2c3d4e5f6
Revises: 275e4b30275e
Create Date: 2026-07-19
"""

import sqlalchemy as sa
from alembic import op

revision = 'a1b2c3d4e5f6'
down_revision = '275e4b30275e'
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table(
        'binance_exec_keys',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('api_key', sa.String(length=255), nullable=False),
        sa.Column('encrypted_secret', sa.Text(), nullable=False),
        sa.Column('testnet', sa.Boolean(), nullable=False),
        sa.Column('ip_allowlisted', sa.Boolean(), nullable=False),
        sa.Column('permissions', sa.Text(), nullable=False),
        sa.Column('intake_verified_at', sa.DateTime(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_binance_exec_keys_user_id'), 'binance_exec_keys', ['user_id'], unique=True)

def downgrade() -> None:
    op.drop_index(op.f('ix_binance_exec_keys_user_id'), table_name='binance_exec_keys')
    op.drop_table('binance_exec_keys')
