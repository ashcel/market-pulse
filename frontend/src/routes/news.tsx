import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/features/page-header";
import { useEconomicEvents, useNews } from "@/hooks/queries";
import { NewsImpactCard } from "@/components/features/news-impact-card";
import { SkeletonCard } from "@/components/features/skeletons";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { Impact } from "@/lib/types";
import { prioritizeNews, scoreNewsPriority } from "@/lib/engine/news-priority";
import { UNIVERSE } from "@/lib/engine/market";
import { useWatchlistStore } from "@/stores/watchlist";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";

export const Route = createFileRoute("/news")({
  head: () => ({
    meta: [
      { title: "News Impact — Market Pulse" },
      {
        name: "description",
        content: "Only news that moves markets — filtered by impact and affected assets.",
      },
      { property: "og:title", content: "News Impact — Market Pulse" },
      {
        property: "og:description",
        content: "Signal-first news with expected direction and affected assets.",
      },
    ],
  }),
  component: NewsPage,
});

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

/** Slim strip surfacing upcoming high-impact macro events above the feed —
 * the same "economy/Fed" news the priority rule bumps to the top, but for
 * events that haven't happened yet (scheduled, not yet reported). */
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

const TOUR_SEEN_KEY = "iq-news-tour-v1";

const TOUR_STEPS: TourStep[] = [
  {
    target: "filters",
    title: "Impact filters",
    body: "Filter the feed by how much a story is expected to move the market. Start with High when you're short on time — those are the stories most likely to change today's picture.",
  },
  {
    target: "feed",
    title: "Signal-first news",
    body: "Each card shows the expected direction (bullish, bearish, or neutral), the impact level, and exactly which assets the story affects — so you read for trading relevance, not just headlines.",
  },
];

function NewsPage() {
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
  const tour = useProductTour(TOUR_SEEN_KEY);

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <PageHeader
        eyebrow="News"
        title="News Impact"
        subtitle="Only the news that moves markets today."
        action={<HelpButton onClick={tour.start} />}
      />

      <EconomicEventsStrip />

      <div data-tour="filters" className="flex flex-wrap gap-1.5">
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

      <div data-tour="feed" className="grid gap-3 sm:grid-cols-2">
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

      <ProductTour steps={TOUR_STEPS} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}
