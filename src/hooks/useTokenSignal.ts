import { useQuery } from "@tanstack/react-query";

import { fetchTimeframeAlignment } from "@/lib/engine/alignment";
import { computePivots, computeTrendLines } from "@/lib/engine/analysis";
import {
  dropUnclosedCandle,
  fetchBinanceKlines,
  fetchBinancePrice,
  type MarketType,
} from "@/lib/engine/binance";
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
  /**
   * The still-forming bar, display-only. Signal evaluation stays gated on
   * closed bars (`candles`), but rendering only the closed set leaves the
   * chart's last candle up to a full bar-duration behind the live-anchored
   * entry/stop/target lines — this closes that visual gap.
   */
  liveCandle: Candle | null;
}

// Chart/indicators stay on the usual 200-bar window; the backtest gets a much
// deeper history (Binance's per-request max) so its win-rate/expectancy stats
// rest on more than a handful of sampled trades.
const CHART_CANDLE_LIMIT = 200;
const BACKTEST_CANDLE_LIMIT = 1000;

function buildSignalData(
  symbol: string,
  candles: Candle[],
  backtestCandles: Candle[],
  source: "live" | "demo",
  settings: RiskSettings,
  livePrice?: number,
  liveCandle: Candle | null = null,
): TokenSignalData {
  const ticker = symbol.toUpperCase();
  const pivots = computePivots(candles);
  const trendLines = computeTrendLines(candles, pivots);
  const backtestPivots = computePivots(backtestCandles);
  const evaluation = evaluateSignal(
    ticker,
    candles,
    pivots,
    settings,
    backtestCandles,
    backtestPivots,
    livePrice,
  );

  return { candles, pivots, trendLines, evaluation, source, liveCandle };
}

export function useTokenSignal(
  symbol: string,
  timeframe: TokenTimeframe,
  market: MarketType = "spot",
) {
  const risk = usePreferencesStore((s) => s.risk);
  const refreshIntervalMs = usePreferencesStore((s) => s.refreshIntervalMs);
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
      market,
      risk.accountSize,
      risk.maxRiskPerTradePercent,
      risk.minimumRewardRisk,
      risk.stopMethod,
    ],
    staleTime: 60_000,
    refetchInterval: refreshIntervalMs > 0 ? Math.max(refreshIntervalMs, 30_000) : false,
    queryFn: async (): Promise<TokenSignalData> => {
      const [history, livePrice] = await Promise.all([
        fetchBinanceKlines(symbol, timeframe, BACKTEST_CANDLE_LIMIT, undefined, market),
        fetchBinancePrice(symbol, market),
      ]);
      if (history.length > 0) {
        // Trade off the last closed bar, not the one still forming — see
        // dropUnclosedCandle. The risk plan's entry still anchors on
        // `livePrice` so switching timeframes doesn't quote a different
        // "current price" per bar's staleness.
        const closed = dropUnclosedCandle(history);
        const candles = closed.slice(-CHART_CANDLE_LIMIT);
        const forming = closed.length < history.length ? history[history.length - 1] : null;
        // Pin the forming candle's close to the same live price the risk plan
        // uses, so the chart's last bar and the entry/stop/target lines meet
        // exactly instead of leaving a gap the size of one bar's drift.
        const liveCandle =
          forming && livePrice
            ? {
                ...forming,
                close: livePrice,
                high: Math.max(forming.high, livePrice),
                low: Math.min(forming.low, livePrice),
              }
            : forming;
        return buildSignalData(
          symbol,
          candles,
          closed,
          "live",
          settings,
          livePrice ?? undefined,
          liveCandle,
        );
      }

      const demoHistory = generateMockCandles(symbol, timeframe, BACKTEST_CANDLE_LIMIT);
      return buildSignalData(
        symbol,
        demoHistory.slice(-CHART_CANDLE_LIMIT),
        demoHistory,
        "demo",
        settings,
      );
    },
  });
}

// Full engine evaluation per timeframe: feeds the bias dots above the
// timeframe buttons and the intent assessments in the decision assistant.
// One server round trip evaluates all timeframes, sized to the user's risk
// preferences so per-intent plans match their account.
export function useTimeframeAlignment(symbol: string, market: MarketType = "spot") {
  const risk = usePreferencesStore((s) => s.risk);
  return useQuery({
    queryKey: [
      "tf-alignment",
      symbol.toUpperCase(),
      market,
      risk.accountSize,
      risk.maxRiskPerTradePercent,
      risk.minimumRewardRisk,
      risk.stopMethod,
    ],
    queryFn: () => fetchTimeframeAlignment(symbol, risk, market),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}
