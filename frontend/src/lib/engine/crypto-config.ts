import { DEFAULT_RISK_SETTINGS, type RiskSettings } from "./quant";

export const CRYPTO_RISK_SETTINGS: RiskSettings = {
  ...DEFAULT_RISK_SETTINGS,
  atrStopMultiplier: 2,
  minimumRewardRisk: 1.6,
  maxRiskPerTradePercent: 0.5,
};
