import { createFileRoute } from "@tanstack/react-router";
import { useAssets } from "@/hooks/queries";
import { MarketCard } from "@/components/iq/market-card";
import { PageHeader } from "@/components/iq/page-header";
import { SkeletonCard } from "@/components/iq/skeletons";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AssetCategory } from "@/lib/types";

export const Route = createFileRoute("/markets")({
  head: () => ({
    meta: [
      { title: "Markets — IQ" },
      { name: "description", content: "Full market overview across crypto, stocks, ETFs, commodities, and FX." },
      { property: "og:title", content: "Markets — IQ" },
      { property: "og:description", content: "Live view of every asset IQ tracks." },
    ],
  }),
  component: MarketsPage,
});

const FILTERS: { label: string; value: AssetCategory | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Crypto", value: "crypto" },
  { label: "Stocks", value: "stocks" },
  { label: "ETFs", value: "etf" },
  { label: "Commodities", value: "commodity" },
  { label: "FX", value: "fx" },
];

function MarketsPage() {
  const { data } = useAssets();
  const [filter, setFilter] = useState<AssetCategory | "all">("all");
  const filtered = data?.filter((a) => filter === "all" || a.category === filter);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader eyebrow="Overview" title="Markets" subtitle="Live snapshot across every asset class." />

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
          ? filtered.map((a) => <MarketCard key={a.id} asset={a} />)
          : Array.from({ length: 10 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    </div>
  );
}
