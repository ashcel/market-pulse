import { useAssets, useRegime } from "@/hooks/queries";

import { MarketCard } from "../market-card";

/**
 * The market snapshot, compacted for a phone-width webview: the regime line
 * the dashboard leads with, then the same MarketCards the web app renders in a
 * two-up grid. Deliberately a reuse, not a second implementation — one snapshot
 * source keeps the Mini App and the web app from quoting different prices.
 */
export function MarketTab() {
  const assets = useAssets();
  const regime = useRegime();

  return (
    <div className="flex flex-col gap-3">
      {regime.data && (
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Regime</div>
          <div className="text-sm font-semibold tracking-tight">{regime.data.regime}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            keyakinan {regime.data.confidence}% · tren {regime.data.trendStrength}
          </div>
        </div>
      )}

      {assets.isLoading && (
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-surface" />
          ))}
        </div>
      )}

      {assets.isError && (
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          Data market tidak bisa dimuat.
        </div>
      )}

      {assets.data && (
        <div className="grid grid-cols-2 gap-2">
          {assets.data.map((asset) => (
            <MarketCard key={asset.ticker} asset={asset} />
          ))}
        </div>
      )}
    </div>
  );
}
