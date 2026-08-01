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

    # AI News Intelligence — OpenAI-compatible LLM for sentiment analysis
    # Uses OpenCode Zen free tier (deepseek-v4-flash-free - no API key needed)
    LLM_API_KEY: str = ""
    LLM_BASE_URL: str = "https://opencode.ai/zen/v1"
    LLM_MODEL: str = "deepseek-v4-flash-free"
    # How often sentiment pass runs (seconds). Default 60 min.
    SENTIMENT_PASS_INTERVAL_S: int = 3600
    # Max headlines per sentiment analysis batch
    SENTIMENT_MAX_HEADLINES: int = 50
    # How far back to look for headlines (hours)
    SENTIMENT_WINDOW_HOURS: int = 48

    # Sprint 1 "satu mulut" delivery (docs/IMPLEMENTATION-PLAN.md §3). One
    # platform Telegram bot, send-only — never getUpdates/setWebhook, so it
    # can never steal notifier-bot's tracking.js callbacks (R2). Default OFF:
    # the running cron tick is a no-op until an operator flips this true.
    DELIVERY_ENABLED: bool = False
    PLATFORM_BOT_TOKEN: str = ""
    PLATFORM_CHAT_ID: str = ""
    # WIB (Asia/Jakarta) hours during which only severity='info' alerts are held.
    QUIET_HOURS_START: int = 22
    QUIET_HOURS_END: int = 6

    # Sprint 2 "balik arah" (docs/IMPLEMENTATION-PLAN.md §2.1). Which
    # `signal_events.source` values are eligible to surface in the read models
    # (Opportunities, the quant feed). This allowlist stands in for a
    # per-row shadow/live status until a second source starts writing
    # (Sprint 5) — one knob beats a column nobody can vary yet.
    SIGNAL_SOURCES_LIVE: list[str] = ["quant"]

    # Sprint 4 position-risk pass. Kept off until the operator has observed
    # the read path in production; this pass must never create alerts by
    # default merely because the worker is deployed.
    POSITION_RISK_ALERTS: bool = False

    # Sprint 5 evidence plane (docs/IMPLEMENTATION-PLAN.md §3 Sprint 5 task 1).
    # The nightly 00:00 UTC scorecard pass. Default OFF: the cron is registered
    # unconditionally but `run_scorecard_pass` is the no-op gate, so flipping
    # this needs no restart of the worker — the very next midnight computes.
    SCORECARD_ENABLED: bool = False
    # Rolling window the nightly pass scores over. R4 (660 MB free): keep this
    # bounded, the query runs against production Postgres.
    SCORECARD_WINDOW_DAYS: int = 30
    # Guard for the nightly query (R4). Postgres syntax, applied as SET LOCAL.
    SCORECARD_STATEMENT_TIMEOUT: str = "30s"

    # Sprint 5 task 5: the forecast cone is now computed in-app
    # (`frontend/src/lib/forecast/`), so `/quant/token` has no caller once the
    # client's PORT_FORECAST is on. Flip this to retire the proxy endpoint
    # WITHOUT deleting code — it starts answering 410 Gone, which makes any
    # remaining caller visible in the logs before the route is removed for
    # good. `/quant/state` and its FEED_FROM_DB behaviour are untouched.
    PORT_FORECAST: bool = False


settings = Config()
