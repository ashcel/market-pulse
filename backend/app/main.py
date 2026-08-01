from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.router import router as auth_router
from app.binance_review.router import router as binance_review_router
from app.config import settings
from app.database import engine, get_db
from app.delivery.router import router as delivery_router
from app.events.router import router as events_router
from app.exceptions import register_exception_handlers
from app.execution.alert_router import router as alert_router
from app.execution.decision_router import router as decision_router
from app.execution.exec_key_router import router as exec_key_router
from app.execution.execute_router import router as execute_router
from app.execution.executions_read_router import router as executions_read_router
from app.execution.permits_router import router as permits_router
from app.execution.position_router import router as position_router
from app.execution.router import router as execution_router
from app.execution.skip_check_router import router as skip_check_router
from app.health_service import build_health
from app.market.batch_router import router as batch_router
from app.market.router import router as market_router
from app.news_intel.router import router as news_intel_router
from app.ai_desk.router import router as ai_desk_router
from app.quant.router import router as quant_router
from app.review.router import router as review_router
from app.trades.router import router as trades_router
from app.tradeway.router import router as tradeway_router

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
    checks: dict[str, Any]


class HealthResponse(BaseModel):
    data: HealthData
    meta: None = None
    error: None = None


@v1_router.get("/health", tags=["system"], summary="Operational health probe")
async def health(db: Annotated[AsyncSession, Depends(get_db)]) -> HealthResponse:
    snapshot = await build_health(db)
    return HealthResponse(
        data=HealthData(
            status=snapshot["status"],
            version=settings.APP_VERSION,
            environment=snapshot.get("environment", settings.ENVIRONMENT),
            checks=snapshot["checks"],
        )
    )


v1_router.include_router(auth_router)
v1_router.include_router(market_router)
v1_router.include_router(batch_router)
v1_router.include_router(trades_router)
v1_router.include_router(binance_review_router)
v1_router.include_router(review_router)
v1_router.include_router(execution_router)
v1_router.include_router(decision_router)
v1_router.include_router(skip_check_router)
v1_router.include_router(permits_router)
v1_router.include_router(execute_router)
v1_router.include_router(exec_key_router)
v1_router.include_router(position_router)
v1_router.include_router(executions_read_router)
v1_router.include_router(events_router)
v1_router.include_router(news_intel_router)
v1_router.include_router(ai_desk_router)
v1_router.include_router(alert_router)
v1_router.include_router(delivery_router)
v1_router.include_router(quant_router)
v1_router.include_router(tradeway_router)

app.include_router(v1_router)
