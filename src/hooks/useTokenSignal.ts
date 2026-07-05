import { useQuery } from "@tanstack/react-query";

import { computePivots, computeTrendLines } from "@/lib/engine/analysis";
import { fetchBinanceKlines } from "@/lib/engine/binance";
import { CRYPTO_RISK_SETTINGS } from "@/lib/engine/crypto-config";
import { generateMockCandles, type TokenTimeframe } from "@/lib/engine/mock-candles";
import { evaluateSignal } from "@/lib/engine/quant";
import { usePreferencesStore } from "@/stores/preferences";
import type { TrendLines } from "@/lib/engine/analysis";
import type { Candle, PivotPoint } from "@/lib/engine/types";
import type { RiskSettings, SignalEvaluation } from "@/lib/engine/quant";

export interface TokenSignalData {
  candles: Candle[];
  pivots: PivotPoint[];
  trendLines: TrendLines;
  evaluation: SignalEvaluation;
  source: "live" | "demo";
}

function buildSignalData(
  symbol: string,
  candles: Candle[],
  source: "live" | "demo",
  settings: RiskSettings,
): TokenSignalData {
  const ticker = symbol.toUpperCase();
  const pivots = computePivots(candles);
  const trendLines = computeTrendLines(candles, pivots);
  const evaluation = evaluateSignal(ticker, candles, pivots, settings);

  return { candles, pivots, trendLines, evaluation, source };
}

export function useTokenSignal(symbol: string, timeframe: TokenTimeframe) {
  const risk = usePreferencesStore((s) => s.risk);
  // Personal risk preferences drive stop placement and position sizing.
  const settings: RiskSettings = {
    ...CRYPTO_RISK_SETTINGS,
    accountSize: risk.accountSize,
    maxRiskPerTradePercent: risk.maxRiskPerTradePercent,
    minimumRewardRisk: risk.minimumRewardRisk,
    stopMethod: risk.stopMethod,
  };

  return useQuery({
    queryKey: [
      "token-signal",
      symbol.toUpperCase(),
      timeframe,
      risk.accountSize,
      risk.maxRiskPerTradePercent,
      risk.minimumRewardRisk,
      risk.stopMethod,
    ],
    staleTime: 60_000,
    queryFn: async (): Promise<TokenSignalData> => {
      const candles = await fetchBinanceKlines(symbol, timeframe);
      if (candles.length > 0) {
        return buildSignalData(symbol, candles, "live", settings);
      }

      return buildSignalData(symbol, generateMockCandles(symbol, timeframe), "demo", settings);
    },
  });
}
