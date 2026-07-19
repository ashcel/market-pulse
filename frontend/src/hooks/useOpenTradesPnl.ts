import { useEffect, useId } from "react";

import { registerLiveInterest, unregisterLiveInterest } from "@/lib/engine/binance-live-feed";
import type { MarketType } from "@/lib/engine/binance";
import { normalizeTicker } from "@/lib/engine/symbol-map";
import { tickKey, useLivePriceStore } from "@/stores/live-prices";
import { usePreferencesStore } from "@/stores/preferences";
import { useOpenTrades, type Trade } from "@/hooks/useTrades";

export interface OpenTradePnl {
  trade: Trade;
  /** Live last price, or null until the first tick arrives. */
  livePrice: number | null;
  /** Unrealized PnL in quote currency (mirrors the close-trade formula: × leverage). */
  unrealizedPnl: number | null;
  /** Unrealized PnL as a percent of entry (leverage-adjusted). */
  unrealizedPct: number | null;
}

export interface OpenTradesPnl {
  rows: OpenTradePnl[];
  /** Sum of every row's unrealized PnL (rows still awaiting a tick count as 0). */
  totalUnrealized: number;
  /** How many open positions have at least one live tick. */
  livePriced: number;
  count: number;
  authenticated: boolean;
  isLoading: boolean;
}

/**
 * Open trades enriched with live unrealized PnL, derived client-side from the
 * shared Binance live-price feed — no backend change, no stored mark price.
 * Powers both the running-trades view and the floating PnL widget so the two
 * always agree. Uses the same PnL math as `useCloseTrade`.
 *
 * Marks against the app's active spot/perp mode (the global TopBar toggle,
 * `preferences.marketType`) so live PnL tracks whichever venue the user is
 * pricing everything else against. Pass `marketOverride` to force one.
 */
export function useOpenTradesPnl(marketOverride?: MarketType): OpenTradesPnl {
  const storeMarket = usePreferencesStore((s) => s.marketType);
  const market = marketOverride ?? storeMarket;
  const { trades, authenticated, isLoading } = useOpenTrades();
  const ticks = useLivePriceStore((s) => s.ticks);

  // Caller ids MUST be unique per hook instance. The floating PnL widget (always
  // mounted via __root) and the /trades page both call this hook at the same
  // time; the live-feed registry is keyed by caller id, so if both used the same
  // `open-pnl:${id}` key, one instance's effect cleanup would unregister the
  // interest the other still needs — tearing down the socket and freezing PnL.
  // A per-instance `useId` prefix keeps the two consumers' interests distinct.
  const instanceId = useId();

  // Register live interest for every open symbol; one caller id per trade so
  // closed positions unsubscribe when the trade list changes.
  const symbolKey = trades.map((t) => t.symbol).join(",");
  useEffect(() => {
    if (!authenticated) return;
    const ids: string[] = [];
    for (const t of trades) {
      const ticker = normalizeTicker(t.symbol);
      if (!ticker) continue;
      const cid = `open-pnl:${instanceId}:${t.id}`;
      registerLiveInterest(cid, { kind: "ticker", market, ticker });
      ids.push(cid);
    }
    return () => ids.forEach(unregisterLiveInterest);
    // symbolKey captures the set of symbols; ids are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolKey, market, authenticated, instanceId]);

  const rows: OpenTradePnl[] = trades.map((t) => {
    const livePrice = ticks[tickKey(market, normalizeTicker(t.symbol))]?.price ?? null;
    if (livePrice === null) {
      return { trade: t, livePrice: null, unrealizedPnl: null, unrealizedPct: null };
    }
    const perUnit = t.direction === "long" ? livePrice - t.entry_price : t.entry_price - livePrice;
    const unrealizedPnl = Math.round(perUnit * t.quantity * t.leverage * 100) / 100;
    const unrealizedPct = Math.round((perUnit / t.entry_price) * 100 * t.leverage * 100) / 100;
    return { trade: t, livePrice, unrealizedPnl, unrealizedPct };
  });

  const totalUnrealized =
    Math.round(rows.reduce((sum, r) => sum + (r.unrealizedPnl ?? 0), 0) * 100) / 100;
  const livePriced = rows.filter((r) => r.livePrice !== null).length;

  return {
    rows,
    totalUnrealized,
    livePriced,
    count: trades.length,
    authenticated,
    isLoading,
  };
}
