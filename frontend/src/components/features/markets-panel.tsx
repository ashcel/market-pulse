import { Link } from "@tanstack/react-router";
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

const FILTERS: { label: string; value: string }[] = [
  { label: "All", value: "all" },
  ...SECTOR_ORDER.map((s) => ({ label: s, value: s })),
];

const TOUR_SEEN_KEY = "iq-markets-tour-v1";

const TOUR_STEPS: TourStep[] = [
  {
    target: "filters",
    title: "Sector filters",
    body: "Narrow the universe to one sector — Majors, Layer 1, DeFi, AI, or Meme — or view everything at once. Sectors matter because money usually rotates between them rather than lifting the whole market.",
  },
  {
    target: "grid",
    title: "Market cards",
    body: "Every tracked asset with live price, 24-hour change, and a mini trend line, ranked by Market Pulse score (the engine's 0–100 quality rating). Click any card to open the full chart, signal, and trade plan for that token.",
  },
];

export function MarketsPanel() {
  const { data } = useAssets();
  const [filter, setFilter] = useState<string>("all");
  const filtered = data?.filter((a) => filter === "all" || a.sector === filter);
  const tour = useProductTour(TOUR_SEEN_KEY);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Overview"
        title="Markets"
        subtitle="Live Binance snapshot across the tracked universe, ranked by Market Pulse score."
        action={<HelpButton onClick={tour.start} />}
      />

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

      <ProductTour steps={TOUR_STEPS} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}
