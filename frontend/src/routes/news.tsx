import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
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

const FILTER_VALUES: { labelKey: string; value: Impact | "all" }[] = [
  { labelKey: "filterAll", value: "all" },
  { labelKey: "filterHigh", value: "high" },
  { labelKey: "filterMedium", value: "medium" },
  { labelKey: "filterLow", value: "low" },
];

function timeUntil(occursAt: string, t: ReturnType<typeof useTranslation>["t"]): string {
  const hours = Math.round((new Date(occursAt).getTime() - Date.now()) / (60 * 60 * 1000));
  if (hours < 1) return t("routes.news.soon");
  if (hours < 24) return t("routes.news.inHours", { count: hours });
  return t("routes.news.inDays", { count: Math.round(hours / 24) });
}

/** Slim strip surfacing upcoming high-impact macro events above the feed —
 * the same "economy/Fed" news the priority rule bumps to the top, but for
 * events that haven't happened yet (scheduled, not yet reported). */
function EconomicEventsStrip() {
  const { t } = useTranslation();
  const { data: events } = useEconomicEvents(3, "high");
  if (!events || events.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-warning">
        {t("routes.news.upcoming")}
      </span>
      {events.slice(0, 4).map((e) => (
        <span
          key={e.id}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11px]"
        >
          <span className="font-medium text-foreground">{e.title}</span>
          <span className="text-muted-foreground">
            {e.country} · {timeUntil(e.occursAt, t)}
          </span>
        </span>
      ))}
    </div>
  );
}

const TOUR_SEEN_KEY = "iq-news-tour-v1";

function useTourSteps(): TourStep[] {
  const { t } = useTranslation();
  return (["filters", "feed"] as const).map((target) => ({
    target,
    title: t(`routes.news.tour.${target}.title`),
    body: t(`routes.news.tour.${target}.body`),
  }));
}

function NewsPage() {
  const { t } = useTranslation();
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
  const tourSteps = useTourSteps();

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <PageHeader
        eyebrow={t("routes.news.eyebrow")}
        title={t("routes.news.title")}
        subtitle={t("routes.news.subtitle")}
        action={<HelpButton onClick={tour.start} />}
      />

      <EconomicEventsStrip />

      <div data-tour="filters" className="flex flex-wrap gap-1.5">
        {FILTER_VALUES.map((f) => (
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
            {t(`routes.news.${f.labelKey}`)}
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

      <ProductTour steps={tourSteps} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}
