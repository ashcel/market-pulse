import { create } from "zustand";

import type { MarketType } from "@/lib/engine/binance";

/**
 * Deliberately NOT persisted (unlike every other store in src/stores/) — this
 * holds ephemeral WebSocket ticks, not user preferences. Written only by
 * binance-live-feed.ts; read by useLivePrice and the dashboard's asset
 * overlay (useAssets/useTopAssets in hooks/queries).
 */
export interface LivePriceTick {
  price: number;
  change24h: number;
  updatedAt: number;
}

interface LivePriceState {
  ticks: Record<string, LivePriceTick>;
  setTick: (market: MarketType, ticker: string, tick: LivePriceTick) => void;
  clearTick: (market: MarketType, ticker: string) => void;
}

export function tickKey(market: MarketType, ticker: string): string {
  return `${market}:${ticker.toUpperCase()}`;
}

export const useLivePriceStore = create<LivePriceState>()((set) => ({
  ticks: {},
  setTick: (market, ticker, tick) =>
    set((s) => ({ ticks: { ...s.ticks, [tickKey(market, ticker)]: tick } })),
  clearTick: (market, ticker) =>
    set((s) => {
      if (!(tickKey(market, ticker) in s.ticks)) return s;
      const next = { ...s.ticks };
      delete next[tickKey(market, ticker)];
      return { ticks: next };
    }),
}));
