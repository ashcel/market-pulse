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


settings = Config()
