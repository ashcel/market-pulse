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
    # External-context provider keys (worker ingestion). Empty = that provider
    # reports "unconfigured" in ingest_state rather than erroring.
    COINGECKO_API_KEY: str = ""
    COINMARKETCAP_API_KEY: str = ""
    COINMARKETCAL_API_KEY: str = ""
    # New-listing screener. Both are optional and independently degradable:
    # without the X token the social pulse reports "uncollected" instead of a
    # neutral score, and without an indexer key the holder bubble map is
    # unavailable on chains no keyless provider covers (notably BSC).
    X_BEARER_TOKEN: str = ""
    ETHERSCAN_API_KEY: str = ""
    # `hermes send --to telegram:<target>` destination for followed-token
    # listing alerts. Empty disables delivery; the alert is still recorded.
    LISTING_ALERT_TELEGRAM_TARGET: str = ""


settings = Config()
