import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.auth.router import router as auth_router
from app.binance_review.router import router as binance_review_router
from app.config import settings
from app.database import engine
from app.exceptions import register_exception_handlers
from app.execution.exec_key_router import router as exec_key_router
from app.execution.execute_router import router as execute_router
from app.execution.executions_read_router import router as executions_read_router
from app.execution.permits_router import router as permits_router
from app.execution.router import router as execution_router
from app.market.router import router as market_router
from app.momentum.router import router as momentum_router
from app.momentum.scanner import start_momentum_radar, stop_momentum_radar
from app.patterns.router import router as patterns_router
from app.rally_watcher.router import router as rally_watcher_router
from app.rally_watcher.service import start_rally_watcher_cold_start, stop_rally_watcher_cold_start
from app.research.recorder import start_forward_test_recorder, stop_forward_test_recorder
from app.research.router import router as research_router
from app.review.router import router as review_router
from app.trades.router import router as trades_router

# Without this the app's own loggers are silent under uvicorn: only its access
# log reaches journald, so a forward-test capture, a settled record or a
# swallowed exception in the radar leaves no trace. Volume is low by
# construction — these planes log transitions and failures, never ticks.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

SHOW_DOCS_IN = {"local", "staging"}


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # Cold-start the RALLY WATCHER's all-market scan in the background so the
    # first /discover request doesn't block on a 2-5 min full-perp sweep —
    # see `app.rally_watcher.service` for the cache/refresh mechanics.
    await start_rally_watcher_cold_start()
    # The MOMENTUM RADAR owns one Binance websocket for the whole perp
    # universe plus an in-memory scan tick — both live for the process
    # lifetime, so they start here and are cancelled on shutdown.
    await start_momentum_radar()
    # The forward-test recorder observes the radar's confirmed setups and
    # settles them against live prices. Strictly downstream: it reads the
    # scanner and never writes to it, so a recorded outcome can never
    # influence a future detection.
    await start_forward_test_recorder()
    yield
    await stop_forward_test_recorder()
    await stop_momentum_radar()
    await stop_rally_watcher_cold_start()
    await engine.dispose()


app_kwargs: dict[str, Any] = {
    "title": "Market Pulse API",
    "version": settings.APP_VERSION,
    "lifespan": lifespan,
}
if settings.ENVIRONMENT not in SHOW_DOCS_IN:
    app_kwargs["openapi_url"] = None

app = FastAPI(**app_kwargs)

if settings.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

register_exception_handlers(app)

v1_router = APIRouter(prefix="/api/v1")


class HealthData(BaseModel):
    status: str
    version: str
    environment: str


class HealthResponse(BaseModel):
    data: HealthData
    meta: None = None
    error: None = None


@v1_router.get("/health", tags=["system"], summary="Liveness probe")
async def health() -> HealthResponse:
    return HealthResponse(
        data=HealthData(
            status="ok",
            version=settings.APP_VERSION,
            environment=settings.ENVIRONMENT,
        )
    )


v1_router.include_router(auth_router)
v1_router.include_router(market_router)
v1_router.include_router(momentum_router)
v1_router.include_router(research_router)
v1_router.include_router(patterns_router)
v1_router.include_router(rally_watcher_router)
v1_router.include_router(trades_router)
v1_router.include_router(binance_review_router)
v1_router.include_router(review_router)
v1_router.include_router(execution_router)
v1_router.include_router(permits_router)
v1_router.include_router(execute_router)
v1_router.include_router(exec_key_router)
v1_router.include_router(executions_read_router)

app.include_router(v1_router)
