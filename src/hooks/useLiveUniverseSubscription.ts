import { useEffect } from "react";

import { registerLiveInterest, unregisterLiveInterest } from "@/lib/engine/binance-live-feed";
import { UNIVERSE } from "@/lib/engine/market";
import { usePreferencesStore } from "@/stores/preferences";

/**
 * Keeps the whole UNIVERSE ticking live, for whichever market is currently
 * active, for the app's lifetime. Mounted once at the root so dashboard,
 * markets, rankings, rotation, and watchlist all get live prices for free
 * via useAssets()'s overlay (hooks/queries/index.ts) without each page
 * managing its own subscriptions.
 */
export function useLiveUniverseSubscription(): void {
  const marketType = usePreferencesStore((s) => s.marketType);

  useEffect(() => {
    const ids = UNIVERSE.map((entry) => `universe:${entry.ticker}`);
    UNIVERSE.forEach((entry, i) => {
      registerLiveInterest(ids[i], { kind: "ticker", market: marketType, ticker: entry.ticker });
    });
    return () => {
      for (const id of ids) unregisterLiveInterest(id);
    };
  }, [marketType]);
}
