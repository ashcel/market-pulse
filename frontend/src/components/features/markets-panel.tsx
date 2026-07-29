import { Link } from "@tanstack/react-router";
import { useAssets, useSectors } from "@/hooks/queries";
import { MarketCard } from "@/components/features/market-card";
import { PageHeader, SectionHeader } from "@/components/features/page-header";
import { SkeletonCard } from "@/components/features/skeletons";
import { Heatmap } from "@/components/features/heatmap";
import { AlternativesCard } from "@/components/features/market-opportunities-card";
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

const TOUR_SEEN_KEY = "iq-markets-tour-v2";

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
  {
    target: "heatmap",
    title: "Capital flow heatmap",
    body: "Every tracked sector and its assets coloured by 24-hour performance — green means money flowing in, red means money flowing out. Click a cell to open that token.",
  },
  {
    target: "opportunities",
    title: "Worth scanning",
    body: "A liquidity-gated scan of every Binance USDT pair — which tokens have real range, depth, and trade flow right now. It is a discovery list, not a signal: open a token for the engine's actual verdict.",
  },
];

export function MarketsPanel() {
  const { data } = useAssets();
  const sectors = useSectors();
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

      <div
        data-tour="filters"
        className="flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0"
      >
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "min-h-11 shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors sm:min-h-0",
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
        className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
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

      <div data-tour="heatmap" className="flex flex-col gap-3">
        <SectionHeader title="Capital Flow Heatmap" />
        {sectors.data ? <Heatmap sectors={sectors.data} /> : <SkeletonCard height={240} />}
      </div>

      <div data-tour="opportunities" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <SectionHeader title="Alternatives" />
          <span className="text-xs text-muted-foreground">When your pick isn't actionable</span>
        </div>
        <AlternativesCard />
      </div>

      <ProductTour steps={TOUR_STEPS} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}
