import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/iq/page-header";
import { useNews } from "@/hooks/queries";
import { NewsImpactCard } from "@/components/iq/news-impact-card";
import { SkeletonCard } from "@/components/iq/skeletons";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Impact } from "@/lib/types";

export const Route = createFileRoute("/news")({
  head: () => ({
    meta: [
      { title: "News Impact — IQ" },
      {
        name: "description",
        content: "Only news that moves markets — filtered by impact and affected assets.",
      },
      { property: "og:title", content: "News Impact — IQ" },
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

function NewsPage() {
  const { data } = useNews();
  const [filter, setFilter] = useState<Impact | "all">("all");
  const filtered = data?.filter((n) => filter === "all" || n.impact === filter);

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <PageHeader
        eyebrow="News"
        title="News Impact"
        subtitle="Only the news that moves markets today."
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

      <div className="grid gap-3 sm:grid-cols-2">
        {filtered
          ? filtered.map((n) => <NewsImpactCard key={n.id} item={n} />)
          : Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} height={160} />)}
      </div>
    </div>
  );
}
