import { useQuery } from "@tanstack/react-query";

import { useLivePrice } from "@/hooks/useLivePrice";
import { fetchTimeframeAlignment } from "@/lib/engine/alignment";
import { computePivots, computeTrendLines, selectDisplayPivots } from "@/lib/engine/analysis";
import {
  dropUnclosedCandle,
  fetchBinanceKlines,
  fetchBinancePrice,
  type MarketType,
} from "@/lib/engine/binance";
import { CRYPTO_RISK_SETTINGS } from "@/lib/engine/crypto-config";
import { generateMockCandles, type TokenTimeframe } from "@/lib/engine/mock-candles";
import { fetchPerpContext, type PerpRead } from "@/lib/engine/perp";
import { computeSessionLevels, type SessionLevel } from "@/lib/engine/sessions";
import { evaluateSignal } from "@/lib/engine/quant";
import { usePreferencesStore } from "@/stores/preferences";
import type { TrendLines } from "@/lib/engine/analysis";
import type { Candle, PivotPoint } from "@/lib/engine/types";
import type { RiskSettings, SignalEvaluation } from "@/lib/engine/quant";

export interface TokenSignalData {
  candles: Candle[];
  pivots: PivotPoint[];
  /** Prominence-selected subset for chart markers — engine logic uses `pivots`. */
  displayPivots: PivotPoint[];
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
  const displayPivots = selectDisplayPivots(pivots, candles);
  const trendLines = computeTrendLines(candles, pivots);
  const evaluation = evaluateSignal(ticker, candles, pivots, settings, backtestCandles, livePrice);

  return { candles, pivots, displayPivots, trendLines, evaluation, source, liveCandle };
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

  // Anchor price is shared per symbol+market, deliberately NOT per timeframe.
  // Each timeframe used to fetch its own copy of fetchBinancePrice on its own
  // schedule, so re-visiting a tab that hadn't refetched in a while showed a
  // different "current price" than a freshly-fetched one — the exact bug the
  // old inline comments here claimed was already handled. A live WS tick (see
  // useLivePrice/binance-live-feed.ts), which is also keyed by symbol+market
  // only, takes priority over the REST fallback whenever one has arrived.
  const live = useLivePrice(symbol, true, market);
  const anchorQuery = useQuery({
    queryKey: ["live-anchor-price", symbol.toUpperCase(), market],
    queryFn: () => fetchBinancePrice(symbol, market),
    staleTime: 30_000,
    refetchInterval: refreshIntervalMs > 0 ? Math.max(refreshIntervalMs, 30_000) : false,
  });
  const anchorPrice = live?.price ?? anchorQuery.data ?? undefined;

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
      const history = await fetchBinanceKlines(
        symbol,
        timeframe,
        BACKTEST_CANDLE_LIMIT,
        undefined,
        market,
      );
      if (history.length > 0) {
        // Trade off the last closed bar, not the one still forming — see
        // dropUnclosedCandle. The risk plan's entry anchors on the shared
        // anchorPrice so every timeframe quotes the same "current price".
        const closed = dropUnclosedCandle(history);
        const candles = closed.slice(-CHART_CANDLE_LIMIT);
        const forming = closed.length < history.length ? history[history.length - 1] : null;
        // Pin the forming candle's close to the same anchor the risk plan
        // uses, so the chart's last bar and the entry/stop/target lines meet
        // exactly instead of leaving a gap the size of one bar's drift.
        const liveCandle =
          forming && anchorPrice
            ? {
                ...forming,
                close: anchorPrice,
                high: Math.max(forming.high, anchorPrice),
                low: Math.min(forming.low, anchorPrice),
              }
            : forming;
        return buildSignalData(symbol, candles, closed, "live", settings, anchorPrice, liveCandle);
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

// Perp funding + open interest, fetched only in perp mode (spot has neither).
// Funding settles every 8h and OI is sampled hourly, so this refreshes on a
// relaxed cadence rather than the fast signal poll — enough to keep the
// crowding read current without hammering the futures API.
export function usePerpContext(symbol: string, market: MarketType) {
  return useQuery<PerpRead | null>({
    queryKey: ["perp-context", symbol.toUpperCase()],
    queryFn: () => fetchPerpContext(symbol),
    enabled: market === "perp",
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

// Asia / London / New York session high-low levels, computed from a week of 1H
// candles server-side. Independent of the chart's timeframe — these are
// intraday structure fed to location grading and (soon) drawn as chart levels.
// Sessions only complete a few times a day, so a relaxed refresh is plenty.
export function useSessionLevels(symbol: string, market: MarketType) {
  return useQuery<SessionLevel[]>({
    queryKey: ["session-levels", symbol.toUpperCase(), market],
    queryFn: async () => {
      const candles = await fetchBinanceKlines(symbol, "1H", 168, undefined, market);
      return candles.length > 0 ? computeSessionLevels(dropUnclosedCandle(candles)) : [];
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
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
