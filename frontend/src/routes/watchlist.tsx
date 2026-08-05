import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Star, X } from "lucide-react";
import { useState } from "react";

import { AssetIcon } from "@/components/features/asset-icon";
import { Change } from "@/components/features/change";
import { IqCard } from "@/components/features/iq-card";
import { formatPrice } from "@/components/features/market-card";
import { MiniChart } from "@/components/features/mini-chart";
import { PageHeader } from "@/components/features/page-header";
import { SearchCommand } from "@/components/features/search-command";
import { StatusBadge } from "@/components/features/status-badge";
import { useAssets } from "@/hooks/queries";
import { useTokenEventsForSymbols } from "@/hooks/useTokenEvents";
import { useWatchlistStore } from "@/stores/watchlist";

/**
 * The watchlist page. The list is the local store synced server-side for
 * signed-in users, and it is what scopes token-event alerts — so this page
 * also shows what each watched token has coming.
 */
export const Route = createFileRoute("/watchlist")({
  head: () => ({
    meta: [
      { title: "Watchlist — Market Pulse" },
      {
        name: "description",
        content: "The tokens you track, with live price, score, and their upcoming events.",
      },
    ],
  }),
  component: WatchlistPage,
});

function WatchlistPage() {
  const tickers = useWatchlistStore((s) => s.tickers);
  const toggle = useWatchlistStore((s) => s.toggle);
  const { data: assets } = useAssets();
  const events = useTokenEventsForSymbols(tickers);
  const [searchOpen, setSearchOpen] = useState(false);

  const eventsBySymbol = new Map<string, number>();
  for (const e of events.data ?? []) {
    eventsBySymbol.set(e.symbol, (eventsBySymbol.get(e.symbol) ?? 0) + 1);
  }

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow="Overview"
        title="Watchlist"
        subtitle="Watched tokens drive your event alerts and the dashboard's catalyst rail."
        action={
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-xs font-semibold text-info transition-colors hover:bg-info/20"
          >
            <Plus className="h-3.5 w-3.5" />
            Add token
          </button>
        }
      />

      {tickers.length === 0 ? (
        <IqCard className="flex flex-col items-center py-12 text-center">
          <Star className="mb-3 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">Your watchlist is empty.</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Add a token to get its unlocks, listings and security events surfaced on the dashboard
            and pushed as alerts.
          </p>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="mt-5 rounded-lg border border-info/30 bg-info/10 px-4 py-2 text-xs font-semibold text-info transition-colors hover:bg-info/20"
          >
            Add your first token
          </button>
        </IqCard>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {tickers.map((ticker) => {
            const asset = assets?.find((a) => a.ticker === ticker);
            const eventCount = eventsBySymbol.get(ticker) ?? 0;
            return (
              <IqCard key={ticker} interactive className="relative flex flex-col gap-3">
                <button
                  type="button"
                  aria-label={`Remove ${ticker} from watchlist`}
                  onClick={() => toggle(ticker)}
                  className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-surface hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <Link
                  to="/token/$symbol"
                  params={{ symbol: ticker }}
                  className="flex flex-col gap-3"
                >
                  <div className="flex items-center gap-2">
                    <AssetIcon ticker={ticker} className="h-7 w-7" />
                    <div className="leading-tight">
                      <div className="text-sm font-semibold">{ticker}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {asset?.name ?? "Not in the tracked universe"}
                      </div>
                    </div>
                  </div>
                  {asset ? (
                    <>
                      <div className="flex items-baseline justify-between">
                        <span className="num text-lg font-semibold">
                          {formatPrice(asset.price)}
                        </span>
                        <Change value={asset.change24h} />
                      </div>
                      <MiniChart
                        data={asset.spark}
                        tone={asset.change24h >= 0 ? "bullish" : "bearish"}
                        height={36}
                      />
                      <div className="flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted-foreground">
                        <span>Score</span>
                        <span className="num font-semibold text-foreground">{asset.score}</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Outside the snapshot universe — open the token page for a live read.
                    </p>
                  )}
                  {eventCount > 0 && (
                    <StatusBadge tone="warning">
                      {eventCount} event{eventCount > 1 ? "s" : ""} in the last 7d
                    </StatusBadge>
                  )}
                </Link>
              </IqCard>
            );
          })}
        </div>
      )}

      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
