import { create } from "zustand";

import type { MarketType } from "@/lib/engine/binance";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { Candle } from "@/lib/engine/types";

/**
 * Live forming candle per market:ticker:interval, fed by Binance's kline WS
 * stream (binance-live-feed.ts) for whichever symbol+timeframe is currently
 * open on the token page — NOT persisted, same rationale as live-prices.ts.
 * REST klines stay the source of truth for closed-bar history/backtesting;
 * this only overlays the chart's forming bar in real time.
 */
export interface LiveKline extends Candle {
  /** Binance's `k.x` — true once this bar has closed. */
  closed: boolean;
}

interface LiveKlineState {
  klines: Record<string, LiveKline>;
  setKline: (key: string, kline: LiveKline) => void;
  clearKline: (key: string) => void;
}

export function klineKey(market: MarketType, ticker: string, timeframe: TokenTimeframe): string {
  return `${market}:${ticker.toUpperCase()}:${timeframe}`;
}

export const useLiveKlineStore = create<LiveKlineState>()((set) => ({
  klines: {},
  setKline: (key, kline) => set((s) => ({ klines: { ...s.klines, [key]: kline } })),
  clearKline: (key) =>
    set((s) => {
      if (!(key in s.klines)) return s;
      const next = { ...s.klines };
      delete next[key];
      return { klines: next };
    }),
}));
