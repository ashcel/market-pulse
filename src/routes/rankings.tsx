import { Link, createFileRoute } from "@tanstack/react-router";
import { useAssets } from "@/hooks/queries";
import { PageHeader } from "@/components/iq/page-header";
import { IqCard } from "@/components/iq/iq-card";
import { AssetIcon } from "@/components/iq/asset-icon";
import { Change } from "@/components/iq/change";
import { formatPrice } from "@/components/iq/market-card";
import { MiniChart } from "@/components/iq/mini-chart";
import { SkeletonCard } from "@/components/iq/skeletons";
import { Star, Search, ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useWatchlistStore } from "@/stores/watchlist";
import { SECTOR_ORDER } from "@/lib/engine/market";
import type { Asset } from "@/lib/types";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/iq/product-tour";

export const Route = createFileRoute("/rankings")({
  head: () => ({
    meta: [
      { title: "Rankings — Market Pulse" },
      {
        name: "description",
        content: "Sortable, filterable rankings across every asset Market Pulse tracks.",
      },
      { property: "og:title", content: "Rankings — Market Pulse" },
      {
        property: "og:description",
        content: "Market Pulse score, momentum, strength, and technical rank.",
      },
    ],
  }),
  component: RankingsPage,
});

type Filter = string;
type SortKey = "score" | "momentum" | "strength" | "volume" | "technical" | "confidence" | "change";

const FILTERS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  ...SECTOR_ORDER.map((s) => ({ label: s, value: s })),
  { label: "Favorites", value: "favorites" },
];

const TOUR_SEEN_KEY = "iq-rankings-tour-v1";

const TOUR_STEPS: TourStep[] = [
  {
    target: "controls",
    title: "Search & filters",
    body: "Find any asset by ticker or name, narrow to a single sector, or show only the tokens you starred as Favorites.",
  },
  {
    target: "table",
    title: "The rankings table",
    body: "Every asset scored 0–100 on momentum, strength, volume, and technical quality, plus the engine's current setup call. Click a column header to sort by it (click again to flip the order), click a row to open that token's full analysis, and use the star at the end of a row to add it to your Favorites.",
  },
];

function RankingsPage() {
  const { data } = useAssets();
  const tour = useProductTour(TOUR_SEEN_KEY);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const watchlist = useWatchlistStore();

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = data.filter((a) => {
      if (filter === "favorites" && !watchlist.tickers.includes(a.ticker)) return false;
      if (filter !== "all" && filter !== "favorites" && a.sector !== filter) return false;
      if (q && !`${a.ticker} ${a.name}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const av = sortVal(a, sortKey);
      const bv = sortVal(b, sortKey);
      return sortDir === "desc" ? bv - av : av - bv;
    });
  }, [data, filter, q, sortKey, sortDir, watchlist.tickers]);

  const cycleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow="Rankings"
        title="Asset Rankings"
        subtitle="Momentum, strength, volume, and signal quality computed live from Binance data."
        action={<HelpButton onClick={tour.start} />}
      />

      <div data-tour="controls" className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search ticker or name"
            className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
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
      </div>

      {!data ? (
        <SkeletonCard height={400} />
      ) : (
        <IqCard padded={false} data-tour="table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Th className="pl-5">#</Th>
                  <Th>Asset</Th>
                  <Th>Sector</Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "score"}
                    dir={sortDir}
                    onClick={() => cycleSort("score")}
                  >
                    Score
                  </Th>
                  <Th>Setup</Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "change"}
                    dir={sortDir}
                    onClick={() => cycleSort("change")}
                  >
                    Change
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "momentum"}
                    dir={sortDir}
                    onClick={() => cycleSort("momentum")}
                  >
                    Momentum
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "strength"}
                    dir={sortDir}
                    onClick={() => cycleSort("strength")}
                  >
                    Strength
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "volume"}
                    dir={sortDir}
                    onClick={() => cycleSort("volume")}
                  >
                    Volume
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "technical"}
                    dir={sortDir}
                    onClick={() => cycleSort("technical")}
                  >
                    Technical
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "confidence"}
                    dir={sortDir}
                    onClick={() => cycleSort("confidence")}
                  >
                    Signal
                  </Th>
                  <Th align="right" className="pr-5">
                    Trend
                  </Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a, i) => {
                  const fav = watchlist.tickers.includes(a.ticker);
                  const tokenLink = {
                    to: "/token/$symbol" as const,
                    params: { symbol: a.ticker },
                  };
                  return (
                    <tr
                      key={a.id}
                      className="border-b border-border last:border-0 hover:bg-surface/50"
                    >
                      <td className="text-xs text-muted-foreground">
                        <Link {...tokenLink} className="block py-3 pl-5 pr-2">
                          {i + 1}
                        </Link>
                      </td>
                      <td>
                        <Link {...tokenLink} className="flex items-center gap-2 py-3 pr-2">
                          <AssetIcon ticker={a.ticker} className="h-6 w-6" />
                          <div className="leading-tight">
                            <div className="font-semibold">{a.ticker}</div>
                            <div className="text-[11px] text-muted-foreground">{a.name}</div>
                          </div>
                        </Link>
                      </td>
                      <td className="text-xs uppercase tracking-wider text-muted-foreground">
                        <Link {...tokenLink} className="block py-3 pr-2">
                          {a.sector ?? a.category}
                        </Link>
                      </td>
                      <td className="text-right num font-semibold">
                        <Link {...tokenLink} className="block py-3 pr-2">
                          {a.score}
                        </Link>
                      </td>
                      <td>
                        <Link {...tokenLink} className="block py-3 pr-2">
                          <DecisionChip decision={a.decision} />
                        </Link>
                      </td>
                      <td className="text-right">
                        <Link {...tokenLink} className="block py-3 pr-2">
                          <Change value={a.change24h} />
                        </Link>
                      </td>
                      <td className="text-right num">
                        <Link {...tokenLink} className="block py-3 pr-2">
                          {a.momentum}
                        </Link>
                      </td>
                      <td className="text-right num">
                        <Link {...tokenLink} className="block py-3 pr-2">
                          {a.strength}
                        </Link>
                      </td>
                      <td className="text-right num">
                        <Link {...tokenLink} className="block py-3 pr-2">
                          {a.volume}
                        </Link>
                      </td>
                      <td className="text-right num">
                        <Link {...tokenLink} className="block py-3 pr-2">
                          {a.technical}
                        </Link>
                      </td>
                      <td className="text-right num">
                        <Link {...tokenLink} className="block py-3 pr-2">
                          {a.confidence}
                        </Link>
                      </td>
                      <td>
                        <Link {...tokenLink} className="block py-3 pr-5">
                          <div className="ml-auto max-w-[100px]">
                            <MiniChart
                              data={a.spark}
                              tone={a.change24h >= 0 ? "bullish" : "bearish"}
                              height={24}
                            />
                          </div>
                        </Link>
                      </td>
                      <td className="py-3 pr-3">
                        <button
                          onClick={() => watchlist.toggle(a.ticker)}
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface hover:text-warning"
                          aria-label="Toggle favorite"
                        >
                          <Star className={cn("h-4 w-4", fav && "fill-warning text-warning")} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No assets match your filters.
            </div>
          )}
        </IqCard>
      )}

      <ProductTour steps={TOUR_STEPS} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}

function sortVal(a: Asset, k: SortKey) {
  if (k === "change") return a.change24h;
  return (a[k] as number | undefined) ?? 0;
}

function DecisionChip({ decision }: { decision?: string }) {
  if (!decision) return <span className="text-xs text-muted-foreground">—</span>;
  const bullish = decision === "buy-candidate";
  const bearish = decision === "short-candidate" || decision === "invalidated";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        bullish && "border-bullish/30 bg-bullish-soft text-bullish",
        bearish && "border-bearish/30 bg-bearish-soft text-bearish",
        !bullish && !bearish && "border-border bg-surface text-muted-foreground",
      )}
    >
      {decision.replaceAll("-", " ")}
    </span>
  );
}

function Th({
  children,
  align = "left",
  className,
  sortable,
  active,
  dir,
  onClick,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  sortable?: boolean;
  active?: boolean;
  dir?: "asc" | "desc";
  onClick?: () => void;
}) {
  return (
    <th
      className={cn(
        "py-2 pr-2 font-semibold",
        align === "right" && "text-right",
        align === "left" && "text-left",
        className,
      )}
    >
      {sortable ? (
        <button
          onClick={onClick}
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            active && "text-foreground",
          )}
        >
          {children}
          <ArrowUpDown className={cn("h-3 w-3", active && dir === "asc" && "rotate-180")} />
        </button>
      ) : (
        children
      )}
    </th>
  );
}
