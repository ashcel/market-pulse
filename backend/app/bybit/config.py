from pydantic_settings import BaseSettings, SettingsConfigDict


class BybitConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BYBIT_", env_file=".env", extra="ignore")

    ENCRYPTION_SECRET: str = "change-me-in-production"
    TESTNET: bool = False
    SYNC_LOOKBACK_DAYS: int = 30
    SYNC_CHUNK_DAYS: int = 7
    ENRICH_BATCH_SIZE: int = 200


bybit_settings = BybitConfig()
