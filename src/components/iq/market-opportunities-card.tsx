import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { AssetIcon } from "@/components/iq/asset-icon";
import { Change } from "@/components/iq/change";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { formatPrice } from "@/components/iq/market-card";
import { StatusBadge } from "@/components/iq/status-badge";
import { SkeletonCard } from "@/components/iq/skeletons";
import { KIND_LABEL, SEVERITY_TONE } from "@/components/iq/token-events-card";
import { useOpportunityScan } from "@/hooks/queries";
import { useTokenEventsForSymbols, type TokenEvent } from "@/hooks/useTokenEvents";
import type { MarketOpportunity } from "@/lib/engine/discovery";
import { cn } from "@/lib/utils";

/**
 * Homepage discovery layer: the Binance USDT pairs most worth *scanning*
 * right now, ranked by liquidity + volatility + trade activity across the
 * whole exchange — deliberately wider than the curated UNIVERSE. Explicitly
 * not a signal: no direction, no engine verdict; each row links to the token
 * intelligence page where the actual decision assistant lives.
 */

const SHOWN = 6;

function formatTurnover(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${Math.round(value / 1e6)}M`;
  return `$${Math.round(value / 1e3)}K`;
}

/** Up to two badges per token: one per event kind, newest first. */
function badgesFor(events: TokenEvent[]): TokenEvent[] {
  const byKind = new Map<string, TokenEvent>();
  for (const e of events) if (!byKind.has(e.kind)) byKind.set(e.kind, e);
  return [...byKind.values()].slice(0, 2);
}

function OpportunityRow({
  opportunity: o,
  rank,
  events,
}: {
  opportunity: MarketOpportunity;
  rank: number;
  events: TokenEvent[];
}) {
  return (
    <li>
      <Link
        to="/token/$symbol"
        params={{ symbol: o.ticker }}
        className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface/60"
      >
        <span className="w-4 shrink-0 text-xs text-muted-foreground num">{rank}</span>
        <AssetIcon ticker={o.ticker} className="h-6 w-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold group-hover:text-info">{o.ticker}</span>
            {o.name !== o.ticker && (
              <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
                {o.name}
              </span>
            )}
            {o.tracked && <StatusBadge tone="info">Tracked</StatusBadge>}
            {badgesFor(events).map((e) => (
              <Badge
                key={e.id}
                variant="outline"
                title={e.title}
                className={cn(
                  "px-1 py-0 text-[9px] font-semibold uppercase",
                  SEVERITY_TONE[e.severity],
                )}
              >
                {KIND_LABEL[e.kind] ?? e.kind}
              </Badge>
            ))}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{o.reason}</p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <div className="num text-sm">{o.rangePercent24h.toFixed(1)}%</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            24h range
          </div>
        </div>
        <div className="hidden shrink-0 text-right md:block">
          <div className="num text-sm">{formatTurnover(o.quoteVolume24h)}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Turnover</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="num text-sm">{formatPrice(o.price)}</div>
          <Change value={o.change24h} />
        </div>
      </Link>
    </li>
  );
}

export function MarketOpportunitiesCard() {
  const { data } = useOpportunityScan();
  const top = useMemo(() => data?.opportunities.slice(0, SHOWN) ?? [], [data]);
  const { data: events } = useTokenEventsForSymbols(top.map((o) => o.ticker));

  const eventsBySymbol = useMemo(() => {
    const map = new Map<string, TokenEvent[]>();
    for (const e of events ?? []) map.set(e.symbol, [...(map.get(e.symbol) ?? []), e]);
    return map;
  }, [events]);

  return (
    <IqCard padded={false} data-tour="opportunities">
      <div className="flex flex-wrap items-center justify-between gap-2 p-5 pb-3">
        <div className="flex items-center gap-2">
          <CardEyebrow>Market Opportunities · Worth Scanning</CardEyebrow>
          {data?.source === "demo" && <StatusBadge tone="warning">Demo data</StatusBadge>}
        </div>
        <span className="text-xs text-muted-foreground">Activity scan · not a trade signal</span>
      </div>
      {data ? (
        <>
          <ul className="divide-y divide-border border-t border-border">
            {top.map((o, i) => (
              <OpportunityRow
                key={o.ticker}
                opportunity={o}
                rank={i + 1}
                events={eventsBySymbol.get(o.ticker) ?? []}
              />
            ))}
          </ul>
          <div className="border-t border-border px-5 py-2 text-[11px] text-muted-foreground">
            Liquidity-gated scan of {data.pairsSeen} Binance USDT spot pairs — {data.pairsRanked}{" "}
            liquid pairs ranked by 24h range, depth, and trade flow. Open a token for the
            engine&apos;s actual verdict.
          </div>
        </>
      ) : (
        <div className="p-5 pt-2">
          <SkeletonCard height={220} />
        </div>
      )}
    </IqCard>
  );
}
