import { Link } from "@tanstack/react-router";
import { Plus, Star } from "lucide-react";
import { useState } from "react";

import { AssetIcon } from "./asset-icon";
import { Change } from "./change";
import { CardEyebrow, IqCard } from "./iq-card";
import { formatPrice } from "./market-card";
import { SearchCommand } from "./search-command";
import { useAssets } from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";
import { useWatchlistStore } from "@/stores/watchlist";

/**
 * Watchlist rail. The watchlist is the local zustand store synced to the
 * server for signed-in users (`useWatchlistSync`), and it is what the
 * catalyst/event rails scope themselves to — so an empty one is worth
 * prompting about.
 */
export function WatchlistRail({ limit = 6 }: { limit?: number }) {
  const { isAuthed, isPending } = useAuth();
  const tickers = useWatchlistStore((s) => s.tickers);
  const { data: assets } = useAssets();
  const [searchOpen, setSearchOpen] = useState(false);

  const rows = tickers
    .map((t) => ({ ticker: t, asset: assets?.find((a) => a.ticker === t) }))
    .slice(0, limit);

  // A watchlist only means anything against an account — it is what scopes
  // event alerts server-side. Anonymous visitors get the pitch, not a local
  // list that would silently go nowhere.
  if (isPending) return null;
  if (!isAuthed) {
    return (
      <IqCard padded={false} className="flex flex-col p-5">
        <CardEyebrow>Watchlist</CardEyebrow>
        <p className="mt-2 text-xs text-muted-foreground">
          Sign in to track tokens, get their unlocks and listings on this dashboard, and receive
          alerts when something happens to them.
        </p>
        <Link
          to="/login"
          className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-info/30 bg-info/10 py-2 text-xs font-semibold text-info transition-colors hover:bg-info/20"
        >
          <Star className="h-3.5 w-3.5" />
          Sign in to build a watchlist
        </Link>
      </IqCard>
    );
  }

  return (
    <IqCard padded={false} className="flex flex-col p-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>Watchlist</CardEyebrow>
        {tickers.length > 0 && (
          <Link to="/watchlist" className="text-xs font-medium text-info hover:underline">
            View all
          </Link>
        )}
      </div>

      {tickers.length === 0 ? (
        <>
          <p className="mt-2 text-xs text-muted-foreground">
            Track your favourite assets — watched tokens drive your event alerts and the catalyst
            rail.
          </p>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-info/30 bg-info/10 py-2 text-xs font-semibold text-info transition-colors hover:bg-info/20"
          >
            <Plus className="h-3.5 w-3.5" />
            Add your first token
          </button>
        </>
      ) : (
        <>
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {rows.map(({ ticker, asset }) => (
              <li key={ticker}>
                <Link
                  to="/token/$symbol"
                  params={{ symbol: ticker }}
                  className="flex items-center gap-3 py-2.5 transition-colors hover:bg-surface/50"
                >
                  <AssetIcon ticker={ticker} className="h-6 w-6" />
                  <span className="flex-1 text-sm font-semibold">{ticker}</span>
                  {asset ? (
                    <span className="flex flex-col items-end">
                      <span className="num text-xs">{formatPrice(asset.price)}</span>
                      <Change value={asset.change24h} />
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">not tracked</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="mt-3 flex items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Star className="h-3 w-3" />
            Add token
          </button>
        </>
      )}

      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
    </IqCard>
  );
}
