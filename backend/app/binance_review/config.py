"""Trade Review Binance key settings — env prefix `BINANCE_REVIEW_`.

Deliberately separate from `app.execution.config.execution_settings`: this
key class is read-only (history sync for Trade Review) and carries none of
the execution kill-switch / mainnet-hardening semantics that gate order
placement. `TESTNET` defaults False because Trade Review's whole point is
showing a user's *real* trade history — flip it only for local/staging
testing against Binance's futures testnet.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class BinanceReviewConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BINANCE_REVIEW_", env_file=".env", extra="ignore")

    ENCRYPTION_SECRET: str = "change-me-in-production"
    TESTNET: bool = False
    SYNC_LOOKBACK_DAYS: int = 30
    ENRICH_BATCH_SIZE: int = 200


binance_review_settings = BinanceReviewConfig()
