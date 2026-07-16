from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

from arq.connections import RedisSettings

from app.config import settings


async def health_ping(_ctx: dict[str, Any]) -> str:
    """Placeholder job so the worker unit is runnable; real passes land in Phase 4."""
    return "ok"


class WorkerSettings:
    functions: ClassVar[list[Callable[[dict[str, Any]], Awaitable[str]]]] = [health_ping]
    redis_settings = RedisSettings.from_dsn(str(settings.REDIS_URL))
    keep_result = 300
