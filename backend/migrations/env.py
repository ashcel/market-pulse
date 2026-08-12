"""Alembic migrations environment (async with asyncpg).

Reads DATABASE_URL from the environment first (for deployed/staging use),
then the app settings (which load backend/.env), then alembic.ini.
"""

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

# Import all models so Alembic can detect them
from app.auth.models import User  # noqa: F401
from app.bybit.models import BybitApiKey, BybitSyncLog, BybitTrade  # noqa: F401
from app.database import Base
from app.execution.models import (  # noqa: F401
    ConstitutionAudit,
    TradePermit,
    TradingConstitution,
)
from app.forward_test.models import (  # noqa: F401
    AnticipatorySignalRow,
    EngineRun,
    EvalLog,
    ShadowSignalRow,
    VerdictHold,
)
from app.market.models import Signal, Token  # noqa: F401
from app.research.models import ForwardTestEvent, ForwardTestSetup  # noqa: F401
from app.review.models import TradeReview  # noqa: F401
from app.trades.models import Trade  # noqa: F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _get_url() -> str:
    """Return the DB URL from env, app settings (.env), or the ini file."""
    env_url = os.environ.get("DATABASE_URL")
    if env_url:
        return env_url
    from app.config import settings

    if settings.DATABASE_URL:
        return str(settings.DATABASE_URL)
    url = config.get_main_option("sqlalchemy.url")
    assert url is not None, "sqlalchemy.url must be set"
    return url


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = _get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Run migrations in 'online' mode with async engine."""
    connectable = create_async_engine(_get_url())
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
