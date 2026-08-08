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
from app.patterns.router import router as patterns_router
from app.review.router import router as review_router
from app.trades.router import router as trades_router

SHOW_DOCS_IN = {"local", "staging"}


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
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
v1_router.include_router(patterns_router)
v1_router.include_router(trades_router)
v1_router.include_router(binance_review_router)
v1_router.include_router(review_router)
v1_router.include_router(execution_router)
v1_router.include_router(permits_router)
v1_router.include_router(execute_router)
v1_router.include_router(exec_key_router)
v1_router.include_router(executions_read_router)

app.include_router(v1_router)
