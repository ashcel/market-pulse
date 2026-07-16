from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.config import settings
from app.database import engine
from app.exceptions import register_exception_handlers

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


app.include_router(v1_router)
