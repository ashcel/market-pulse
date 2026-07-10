import { useEffect, useId } from "react";

import type { MarketType } from "@/lib/engine/binance";
import { registerLiveInterest, unregisterLiveInterest } from "@/lib/engine/binance-live-feed";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import { normalizeTicker } from "@/lib/engine/symbol-map";
import { klineKey, type LiveKline, useLiveKlineStore } from "@/stores/live-klines";

/**
 * The live forming candle for one specific symbol+timeframe+market, straight
 * from Binance's kline WS stream — the only source that gives a correct
 * per-interval OHLCV bar (miniTicker only gives last price + 24h change).
 * Meant for whichever timeframe is actually open on the token page, not the
 * whole UNIVERSE — REST klines stay the source of truth for closed-bar
 * history and the (expensive) signal engine, which still runs on its normal
 * refetch cadence; this only keeps the chart's rendered last bar live.
 * Returns null until the first tick, same contract as useLivePrice.
 */
export function useLiveKline(
  symbol: string,
  timeframe: TokenTimeframe,
  enabled: boolean,
  market: MarketType = "spot",
): LiveKline | null {
  const id = useId();
  const ticker = normalizeTicker(symbol);

  useEffect(() => {
    if (!enabled || !ticker) {
      unregisterLiveInterest(id);
      return;
    }
    registerLiveInterest(id, { kind: "kline", market, ticker, timeframe });
    return () => unregisterLiveInterest(id);
  }, [id, enabled, ticker, market, timeframe]);

  return useLiveKlineStore((s) => s.klines[klineKey(market, ticker, timeframe)] ?? null);
}
