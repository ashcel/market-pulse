import { useEffect, useId } from "react";

import type { MarketType } from "@/lib/engine/binance";
import { registerLiveInterest, unregisterLiveInterest } from "@/lib/engine/binance-live-feed";
import { normalizeTicker } from "@/lib/engine/symbol-map";
import { fundingKey, useLiveFundingStore } from "@/stores/live-funding";

export interface LiveFunding {
  /** Current-period funding rate as a decimal (0.0001 = 0.01%). */
  fundingRate: number;
  /** Epoch ms of the next funding settlement. */
  nextFundingMs: number;
  markPrice: number;
}

/**
 * Live funding rate + next-funding countdown + mark price for one
 * symbol+market, straight from Binance's `<pair>@markPrice` WS stream (see
 * binance-live-feed.ts) — updates ~every 3s, far tighter than
 * usePerpContext's 120s REST poll. Perp-only (spot has no funding); returns
 * undefined until the first tick or when not in perp mode, same "no data
 * yet" contract as the rest of the live feed but spelled `undefined` per the
 * funding-play advisor's optional-context convention. usePerpContext's REST
 * poll is left untouched as the fallback/bootstrap source.
 */
export function useLiveFunding(symbol: string, market: MarketType): LiveFunding | undefined {
  const id = useId();
  const ticker = normalizeTicker(symbol);
  const enabled = market === "perp" && ticker.length > 0;

  useEffect(() => {
    if (!enabled) {
      unregisterLiveInterest(id);
      return;
    }
    registerLiveInterest(id, { kind: "markPrice", market, ticker });
    return () => unregisterLiveInterest(id);
  }, [id, enabled, ticker, market]);

  const tick = useLiveFundingStore((s) => s.funding[fundingKey(market, ticker)]);
  if (!enabled || !tick) return undefined;
  return {
    fundingRate: tick.fundingRate,
    nextFundingMs: tick.nextFundingMs,
    markPrice: tick.markPrice,
  };
}
