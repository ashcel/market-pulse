import { useEffect, useId } from "react";

import { registerLiveInterest, unregisterLiveInterest } from "@/lib/engine/binance-live-feed";
import type { MarketType } from "@/lib/engine/binance";
import { normalizeTicker } from "@/lib/engine/symbol-map";
import { tickKey, useLivePriceStore } from "@/stores/live-prices";

export interface LivePrice {
  price: number;
  change24h: number;
}

/**
 * Live last price + 24h change (spot or USDⓈ-M perpetual futures), backed by
 * the shared multiplexed feed in binance-live-feed.ts. Returns null until
 * the first tick — callers should fall back to REST data until then.
 */
export function useLivePrice(
  symbol: string,
  enabled: boolean,
  market: MarketType = "spot",
): LivePrice | null {
  const id = useId();
  const ticker = normalizeTicker(symbol);

  useEffect(() => {
    if (!enabled || !ticker) {
      unregisterLiveInterest(id);
      return;
    }
    registerLiveInterest(id, { market, ticker });
    return () => unregisterLiveInterest(id);
  }, [id, enabled, ticker, market]);

  const tick = useLivePriceStore((s) => s.ticks[tickKey(market, ticker)]);
  return tick ? { price: tick.price, change24h: tick.change24h } : null;
}
