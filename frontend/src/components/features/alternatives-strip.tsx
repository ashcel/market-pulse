import { Link } from "@tanstack/react-router";

import { AssetIcon } from "@/components/features/asset-icon";
import { Change } from "@/components/features/change";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { formatPrice } from "@/components/features/market-card";
import { SkeletonCard } from "@/components/features/skeletons";
import { useOpportunityScan } from "@/hooks/queries";
import { cn } from "@/lib/utils";

/**
 * Homepage alternatives strip — shown when no verdict-live setups exist.
 * Gives the user max 3 tokens worth evaluating instead of a dead end.
 * Each row links to the token page where the actual engine verdict lives.
 */
const SHOWN = 3;

function formatTurnover(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${Math.round(value / 1e6)}M`;
  return `$${Math.round(value / 1e3)}K`;
}

export function AlternativesStrip() {
  const { data, isLoading } = useOpportunityScan();

  if (isLoading) {
    return (
      <IqCard padded={false} className="flex flex-col p-3 sm:p-5">
        <CardEyebrow>Alternatives</CardEyebrow>
        <div className="mt-3 flex flex-col gap-3">
          <SkeletonCard className="h-16 w-full" />
          <SkeletonCard className="h-16 w-full" />
          <SkeletonCard className="h-16 w-full" />
        </div>
      </IqCard>
    );
  }

  if (!data || data.opportunities.length === 0) return null;

  const top = data.opportunities.slice(0, SHOWN);

  return (
    <IqCard padded={false} className="flex flex-col">
      <div className="flex items-center justify-between gap-2 p-3 sm:p-5 sm:pb-3">
        <div className="flex items-center gap-2">
          <CardEyebrow>Alternatives to scan</CardEyebrow>
        </div>
        <span className="text-xs text-muted-foreground">When your pick isn't actionable</span>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {top.map((o, i) => (
          <li key={o.ticker}>
            <Link
              to="/token/$symbol"
              params={{ symbol: o.ticker }}
              className="group flex min-h-11 items-center gap-2 px-3 py-2 transition-colors hover:bg-surface/60 sm:gap-3 sm:px-5 sm:py-2.5"
            >
              <span className="w-4 shrink-0 text-xs text-muted-foreground num">{i + 1}</span>
              <AssetIcon ticker={o.ticker} className="h-5 w-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold group-hover:text-info">{o.ticker}</span>
                  {o.name !== o.ticker && (
                    <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
                      {o.name}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{o.reason}</p>
              </div>
              <div className="hidden shrink-0 text-right sm:block">
                <div className="num text-sm">{o.rangePercent24h.toFixed(1)}%</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  24h range
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="num text-sm">{formatPrice(o.price)}</div>
                <Change value={o.change24h} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground sm:px-5">
        Top {SHOWN} by liquidity + activity — open a token for the engine&apos;s verdict
      </div>
    </IqCard>
  );
}
