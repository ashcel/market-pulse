"""Execution-plane settings (M9 / EDR 0020).

Env prefix ``EXECUTION_`` — so the global kill switch is the env var
``EXECUTION_ENABLED`` (default **off**; off = read-only product). Testnet is
the default target; no mainnet base URL is used until the isolation decision
(U24) is recorded and the operator deliberately flips both ``EXECUTION_ENABLED``
on and ``EXECUTION_TESTNET`` off.

Execution API keys are stored per-user, encrypted at rest (see the execution
key model + crypto), NOT in env — this file holds only operator-controlled
switches, the encryption passphrase, and venue base URLs.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class ExecutionConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="EXECUTION_", env_file=".env", extra="ignore"
    )

    # Global kill switch. Default OFF — no order path is live until an operator
    # sets EXECUTION_ENABLED=true in the service env. Never commit it on.
    ENABLED: bool = False

    # Testnet-first. Default TRUE — mainnet stays unreachable until U24 isolation
    # decision is recorded and this is deliberately set false.
    TESTNET: bool = True

    # Separate encryption passphrase for the execution key class (kept distinct
    # from the read-only sync key class). SHA-256 -> Fernet, same shape as bybit.
    ENCRYPTION_SECRET: str = "change-me-in-production"

    # Binance USDⓈ-M futures venues.
    BINANCE_TESTNET_FUTURES_URL: str = "https://testnet.binancefuture.com"
    BINANCE_MAINNET_FUTURES_URL: str = "https://fapi.binance.com"

    # Account-state staleness bound (seconds). Past this, account state is
    # considered stale and the permit fails closed (STALE_ACCOUNT_STATE).
    ACCOUNT_STATE_MAX_AGE_SECONDS: int = 15

    def futures_base_url(self) -> str:
        return (
            self.BINANCE_TESTNET_FUTURES_URL
            if self.TESTNET
            else self.BINANCE_MAINNET_FUTURES_URL
        )


execution_settings = ExecutionConfig()
