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

DEFAULT_ENCRYPTION_SECRET = "change-me-in-production"


class ExecutionConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EXECUTION_", env_file=".env", extra="ignore")

    # Global kill switch. Default OFF — no order path is live until an operator
    # sets EXECUTION_ENABLED=true in the service env. Never commit it on.
    ENABLED: bool = False

    # Testnet-first. Default TRUE — mainnet stays unreachable until U24 isolation
    # decision is recorded and this is deliberately set false.
    TESTNET: bool = True

    # Separate encryption passphrase for the execution key class (kept distinct
    # from the read-only sync key class). SHA-256 -> Fernet, same shape as bybit.
    ENCRYPTION_SECRET: str = DEFAULT_ENCRYPTION_SECRET

    # Binance USDⓈ-M futures venues.
    BINANCE_TESTNET_FUTURES_URL: str = "https://testnet.binancefuture.com"
    BINANCE_MAINNET_FUTURES_URL: str = "https://fapi.binance.com"

    # Account-state staleness bound (seconds). Past this, account state is
    # considered stale and the permit fails closed (STALE_ACCOUNT_STATE).
    ACCOUNT_STATE_MAX_AGE_SECONDS: int = 15

    # External order calls are bounded. Timeout recovery is state-machine based:
    # persist the current state, reconcile by deterministic client order ids,
    # then resume instead of submitting a fresh logical execution.
    ORDER_TIMEOUT_SECONDS: float = 10.0

    # D1 — the protective stop-loss leg gets a tighter timeout than the entry
    # (with one immediate retry before flatten), shrinking the worst-case
    # unprotected window. Entry keeps ORDER_TIMEOUT_SECONDS.
    SL_ORDER_TIMEOUT_SECONDS: float = 3.0

    # Mainnet stays closed until a separate hardening pass records the
    # production isolation and operational controls.
    MAINNET_HARDENED: bool = False

    def futures_base_url(self) -> str:
        return (
            self.BINANCE_TESTNET_FUTURES_URL if self.TESTNET else self.BINANCE_MAINNET_FUTURES_URL
        )

    def execution_readiness_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.ENABLED:
            errors.append("execution_disabled")
        if (
            self.ENCRYPTION_SECRET == DEFAULT_ENCRYPTION_SECRET
            or not self.ENCRYPTION_SECRET.strip()
        ):
            errors.append("default_encryption_secret")
        if self.ACCOUNT_STATE_MAX_AGE_SECONDS <= 0:
            errors.append("invalid_account_state_max_age")
        if self.ORDER_TIMEOUT_SECONDS <= 0:
            errors.append("invalid_order_timeout")
        if self.SL_ORDER_TIMEOUT_SECONDS <= 0:
            errors.append("invalid_sl_order_timeout")
        if (
            not self.BINANCE_TESTNET_FUTURES_URL.strip()
            or not self.BINANCE_MAINNET_FUTURES_URL.strip()
        ):
            errors.append("invalid_exchange_base_url")
        if self.ENABLED and not self.TESTNET and not self.MAINNET_HARDENED:
            errors.append("mainnet_not_hardened")
        return errors


execution_settings = ExecutionConfig()
