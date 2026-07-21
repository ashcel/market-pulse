import { create } from "zustand";

import type { MarketType } from "@/lib/engine/binance";

/**
 * Live mark price + funding rate per market:ticker, fed by Binance's
 * `<pair>@markPrice` WS stream (binance-live-feed.ts) — updates every ~3s,
 * far tighter than the 120s REST funding poll (usePerpContext). Deliberately
 * NOT persisted (unlike every other store in src/stores/), same rationale as
 * live-prices.ts/live-klines.ts: this is ephemeral WS state, not a user
 * preference.
 */
export interface LiveFundingTick {
  markPrice: number;
  indexPrice: number;
  /** Current-period funding rate as a decimal (0.0001 = 0.01%). */
  fundingRate: number;
  /** Epoch ms of the next funding settlement. */
  nextFundingMs: number;
  updatedAt: number;
}

interface LiveFundingState {
  funding: Record<string, LiveFundingTick>;
  setFunding: (market: MarketType, ticker: string, tick: LiveFundingTick) => void;
  clearFunding: (market: MarketType, ticker: string) => void;
}

export function fundingKey(market: MarketType, ticker: string): string {
  return `${market}:${ticker.toUpperCase()}`;
}

export const useLiveFundingStore = create<LiveFundingState>()((set) => ({
  funding: {},
  setFunding: (market, ticker, tick) =>
    set((s) => ({ funding: { ...s.funding, [fundingKey(market, ticker)]: tick } })),
  clearFunding: (market, ticker) =>
    set((s) => {
      if (!(fundingKey(market, ticker) in s.funding)) return s;
      const next = { ...s.funding };
      delete next[fundingKey(market, ticker)];
      return { funding: next };
    }),
}));
