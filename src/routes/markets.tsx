import { Link, createFileRoute } from "@tanstack/react-router";
import { useAssets } from "@/hooks/queries";
import { MarketCard } from "@/components/iq/market-card";
import { PageHeader } from "@/components/iq/page-header";
import { SkeletonCard } from "@/components/iq/skeletons";
import { SECTOR_ORDER } from "@/lib/engine/market";
import { useState } from "react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/markets")({
  head: () => ({
    meta: [
      { title: "Markets — IQ" },
      {
        name: "description",
        content: "Full market overview across crypto, stocks, ETFs, commodities, and FX.",
      },
      { property: "og:title", content: "Markets — IQ" },
      { property: "og:description", content: "Live view of every asset IQ tracks." },
    ],
  }),
  component: MarketsPage,
});

const FILTERS: { label: string; value: string }[] = [
  { label: "All", value: "all" },
  ...SECTOR_ORDER.map((s) => ({ label: s, value: s })),
];

function MarketsPage() {
  const { data } = useAssets();
  const [filter, setFilter] = useState<string>("all");
  const filtered = data?.filter((a) => filter === "all" || a.sector === filter);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow="Overview"
        title="Markets"
        subtitle="Live Binance snapshot across the tracked universe, ranked by IQ score."
      />

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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
    </div>
  );
}
