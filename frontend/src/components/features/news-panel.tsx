import { useMemo, useState } from "react";
import { useEconomicEvents, useNews } from "@/hooks/queries";
import { NewsImpactCard } from "@/components/features/news-impact-card";
import { SkeletonCard } from "@/components/features/skeletons";
import { SectionHeader } from "@/components/features/page-header";
import { cn } from "@/lib/utils";
import type { Impact } from "@/lib/types";
import { prioritizeNews, scoreNewsPriority } from "@/lib/engine/news-priority";
import { UNIVERSE } from "@/lib/engine/market";
import { useWatchlistStore } from "@/stores/watchlist";

const FILTERS: { label: string; value: Impact | "all" }[] = [
  { label: "All", value: "all" },
  { label: "High", value: "high" },
  { label: "Medium", value: "medium" },
  { label: "Low", value: "low" },
];

function timeUntil(occursAt: string): string {
  const hours = Math.round((new Date(occursAt).getTime() - Date.now()) / (60 * 60 * 1000));
  if (hours < 1) return "soon";
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** Slim strip surfacing upcoming high-impact macro events above the feed. */
function EconomicEventsStrip() {
  const { data: events } = useEconomicEvents(3, "high");
  if (!events || events.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-warning">
        Upcoming
      </span>
      {events.slice(0, 4).map((e) => (
        <span
          key={e.id}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11px]"
        >
          <span className="font-medium text-foreground">{e.title}</span>
          <span className="text-muted-foreground">
            {e.country} · {timeUntil(e.occursAt)}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Impact-first news feed. Extracted from the old `/news` route so it can serve
 * both that route (thin wrapper) and the Markets → News tab
 * (IA revision 2026-07-24: News returns as a Markets tab, not a nav slot).
 * `asSection` swaps the standalone eyebrow for an in-tab section header.
 */
export function NewsPanel({ asSection = false }: { asSection?: boolean } = {}) {
  const { data } = useNews();
  const [filter, setFilter] = useState<Impact | "all">("all");
  const watchedTickers = useWatchlistStore((s) => s.tickers);
  const tickers = useMemo(
    () => [...new Set([...UNIVERSE.map((u) => u.ticker), ...watchedTickers])],
    [watchedTickers],
  );
  const filtered = data?.filter((n) => filter === "all" || n.impact === filter);
  const prioritized = useMemo(() => {
    if (!filtered) return undefined;
    return prioritizeNews(
      filtered.map((n) => ({ ...n, title: n.headline })),
      { tickers },
    );
  }, [filtered, tickers]);

  return (
    <div className="flex flex-col gap-6">
      {asSection && <SectionHeader title="News Impact — only what moves markets today" />}

      <EconomicEventsStrip />

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              filter === f.value
                ? "border-info bg-info-soft text-info"
                : "border-border bg-surface text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {prioritized
          ? prioritized.map((n) => (
              <NewsImpactCard
                key={n.id}
                item={n}
                priority={scoreNewsPriority(n.headline, { tickers })}
              />
            ))
          : Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} height={160} />)}
      </div>
    </div>
  );
}
