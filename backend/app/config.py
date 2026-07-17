from pydantic import PostgresDsn, RedisDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Config(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: PostgresDsn = PostgresDsn(
        "postgresql+asyncpg://postgres:postgres@localhost:5435/market_pulse"
    )
    REDIS_URL: RedisDsn = RedisDsn("redis://localhost:6380/0")
    SITE_DOMAIN: str = "iq.heydewi.com"
    ENVIRONMENT: str = "local"
    CORS_ORIGINS: list[str] = []
    APP_VERSION: str = "0.1.0"
    # Shared secret for server-to-server calls from the TanStack Start frontend.
    # Must be set in production via AUTH_JWT_SECRET env var or directly as INTERNAL_API_KEY.
    INTERNAL_API_KEY: str = ""


settings = Config()
