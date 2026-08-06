import { Link, createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAssets } from "@/hooks/queries";
import { MarketCard } from "@/components/features/market-card";
import { PageHeader } from "@/components/features/page-header";
import { SkeletonCard } from "@/components/features/skeletons";
import { SECTOR_ORDER } from "@/lib/engine/market";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";

export const Route = createFileRoute("/markets")({
  head: () => ({
    meta: [
      { title: "Markets — Market Pulse" },
      {
        name: "description",
        content: "Full market overview across crypto, stocks, ETFs, commodities, and FX.",
      },
      { property: "og:title", content: "Markets — Market Pulse" },
      { property: "og:description", content: "Live view of every asset Market Pulse tracks." },
    ],
  }),
  component: MarketsPage,
});

// Sector names come from the engine's taxonomy (SECTOR_ORDER) and are compared
// by value across the app (heatmap, rotation, market.sector) — left untranslated.
const SECTOR_FILTERS = SECTOR_ORDER.map((s) => ({ label: s, value: s }));

const TOUR_SEEN_KEY = "iq-markets-tour-v1";

function useTourSteps(): TourStep[] {
  const { t } = useTranslation();
  return [
    {
      target: "filters",
      title: t("routes.markets.tour.filters.title"),
      body: t("routes.markets.tour.filters.body"),
    },
    {
      target: "grid",
      title: t("routes.markets.tour.grid.title"),
      body: t("routes.markets.tour.grid.body"),
    },
  ];
}

function MarketsPage() {
  const { t } = useTranslation();
  const { data } = useAssets();
  const [filter, setFilter] = useState<string>("all");
  const filtered = data?.filter((a) => filter === "all" || a.sector === filter);
  const tour = useProductTour(TOUR_SEEN_KEY);
  const tourSteps = useTourSteps();
  const filters = [{ label: t("routes.markets.all"), value: "all" }, ...SECTOR_FILTERS];

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow={t("routes.markets.eyebrow")}
        title={t("routes.markets.title")}
        subtitle={t("routes.markets.subtitle")}
        action={<HelpButton onClick={tour.start} />}
      />

      <div data-tour="filters" className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
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

      <div
        data-tour="grid"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      >
        {filtered
          ? filtered.map((a) => (
              <Link
                key={a.id}
                to="/token/$symbol"
                params={{ symbol: a.ticker }}
                className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MarketCard asset={a} />
              </Link>
            ))
          : Array.from({ length: 10 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>

      <ProductTour steps={tourSteps} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}
