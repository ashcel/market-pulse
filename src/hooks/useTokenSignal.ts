import { useQuery } from "@tanstack/react-query";

import { computePivots, computeTrendLines } from "@/lib/engine/analysis";
import { fetchBinanceKlines } from "@/lib/engine/binance";
import { CRYPTO_RISK_SETTINGS } from "@/lib/engine/crypto-config";
import { generateMockCandles, type TokenTimeframe } from "@/lib/engine/mock-candles";
import { evaluateSignal } from "@/lib/engine/quant";
import type { TrendLines } from "@/lib/engine/analysis";
import type { Candle, PivotPoint } from "@/lib/engine/types";
import type { SignalEvaluation } from "@/lib/engine/quant";

export interface TokenSignalData {
  candles: Candle[];
  pivots: PivotPoint[];
  trendLines: TrendLines;
  evaluation: SignalEvaluation;
  source: "live" | "demo";
}

function buildSignalData(
  symbol: string,
  timeframe: TokenTimeframe,
  candles: Candle[],
  source: "live" | "demo",
): TokenSignalData {
  const ticker = symbol.toUpperCase();
  const pivots = computePivots(candles);
  const trendLines = computeTrendLines(candles, pivots);
  const evaluation = evaluateSignal(ticker, candles, pivots, CRYPTO_RISK_SETTINGS);

  return { candles, pivots, trendLines, evaluation, source };
}

export function useTokenSignal(symbol: string, timeframe: TokenTimeframe) {
  return useQuery({
    queryKey: ["token-signal", symbol.toUpperCase(), timeframe],
    staleTime: 60_000,
    queryFn: async (): Promise<TokenSignalData> => {
      const candles = await fetchBinanceKlines(symbol, timeframe);
      if (candles.length > 0) {
        return buildSignalData(symbol, timeframe, candles, "live");
      }

      return buildSignalData(symbol, timeframe, generateMockCandles(symbol, timeframe), "demo");
    },
  });
}
