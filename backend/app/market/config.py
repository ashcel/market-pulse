from pydantic_settings import BaseSettings, SettingsConfigDict


class MarketConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MARKET_", env_file=".env", extra="ignore")

    DEFAULT_PAGE_SIZE: int = 20
    MAX_PAGE_SIZE: int = 100


market_settings = MarketConfig()
