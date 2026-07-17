"""Crypto-calibrated risk settings (port of crypto-config.ts)."""

from dataclasses import replace

from smc.quant import DEFAULT_RISK_SETTINGS, RiskSettings

CRYPTO_RISK_SETTINGS: RiskSettings = replace(
    DEFAULT_RISK_SETTINGS,
    atr_stop_multiplier=2,
    minimum_reward_risk=1.6,
    max_risk_per_trade_percent=0.5,
)
