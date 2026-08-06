import { Link, createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAssets } from "@/hooks/queries";
import { RsScanCard } from "@/components/features/rs-scan-card";
import { PageHeader } from "@/components/features/page-header";
import { IqCard } from "@/components/features/iq-card";
import { AssetIcon } from "@/components/features/asset-icon";
import { Change } from "@/components/features/change";
import { formatPrice } from "@/components/features/market-card";
import { MiniChart } from "@/components/features/mini-chart";
import { SkeletonCard } from "@/components/features/skeletons";
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
} from "@/components/features/product-tour";

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
type SortKey =
  "score" | "momentum" | "strength" | "volume" | "technical" | "confidence" | "change" | "rs";

// Sector names come from the engine's taxonomy (SECTOR_ORDER), left untranslated (see markets.tsx).
const SECTOR_FILTERS = SECTOR_ORDER.map((s) => ({ label: s, value: s }));

const TOUR_SEEN_KEY = "iq-rankings-tour-v1";

function useTourSteps(): TourStep[] {
  const { t } = useTranslation();
  return (["controls", "table"] as const).map((target) => ({
    target,
    title: t(`routes.rankings.tour.${target}.title`),
    body: t(`routes.rankings.tour.${target}.body`),
  }));
}

function RankingsPage() {
  const { t } = useTranslation();
  const { data } = useAssets();
  const tour = useProductTour(TOUR_SEEN_KEY);
  const tourSteps = useTourSteps();
  const filters = [
    { label: t("routes.rankings.filterAll"), value: "all" },
    ...SECTOR_FILTERS,
    { label: t("routes.rankings.filterFavorites"), value: "favorites" },
  ];
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
        eyebrow={t("routes.rankings.eyebrow")}
        title={t("routes.rankings.title")}
        subtitle={t("routes.rankings.subtitle")}
        action={<HelpButton onClick={tour.start} />}
      />

      <div data-tour="controls" className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("routes.rankings.searchPlaceholder")}
            className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
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
      </div>

      {!data ? (
        <SkeletonCard height={400} />
      ) : (
        <IqCard padded={false} data-tour="table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Th className="pl-5">{t("routes.rankings.colRank")}</Th>
                  <Th>{t("routes.rankings.colAsset")}</Th>
                  <Th>{t("routes.rankings.colSector")}</Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "score"}
                    dir={sortDir}
                    onClick={() => cycleSort("score")}
                    title={t("routes.rankings.colScoreTooltip")}
                  >
                    {t("routes.rankings.colScore")}
                  </Th>
                  <Th>{t("routes.rankings.colSetup")}</Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "change"}
                    dir={sortDir}
                    onClick={() => cycleSort("change")}
                  >
                    {t("routes.rankings.colChange")}
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "rs"}
                    dir={sortDir}
                    onClick={() => cycleSort("rs")}
                  >
                    {t("routes.rankings.colRs")}
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "momentum"}
                    dir={sortDir}
                    onClick={() => cycleSort("momentum")}
                  >
                    {t("routes.rankings.colMomentum")}
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "strength"}
                    dir={sortDir}
                    onClick={() => cycleSort("strength")}
                  >
                    {t("routes.rankings.colStrength")}
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "volume"}
                    dir={sortDir}
                    onClick={() => cycleSort("volume")}
                  >
                    {t("routes.rankings.colVolume")}
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "technical"}
                    dir={sortDir}
                    onClick={() => cycleSort("technical")}
                    title={t("routes.rankings.colTechnicalTooltip")}
                  >
                    {t("routes.rankings.colTechnical")}
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={sortKey === "confidence"}
                    dir={sortDir}
                    onClick={() => cycleSort("confidence")}
                    title={t("routes.rankings.colSignalTooltip")}
                  >
                    {t("routes.rankings.colSignal")}
                  </Th>
                  <Th align="right" className="pr-5">
                    {t("routes.rankings.colTrend")}
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
                      <td className="text-right">
                        <Link {...tokenLink} className="block py-3 pr-2 leading-tight">
                          <RelativeStrengthCell asset={a} />
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
                          aria-label={t("routes.rankings.toggleFavorite")}
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
              {t("routes.rankings.noMatches")}
            </div>
          )}
        </IqCard>
      )}

      <RsScanCard />

      <ProductTour steps={tourSteps} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}

function sortVal(a: Asset, k: SortKey) {
  if (k === "change") return a.change24h;
  if (k === "rs") return a.rsBtc7d ?? 0;
  return (a[k] as number | undefined) ?? 0;
}

/**
 * Relative strength vs BTC (7d % change spread) with the hourly-returns
 * correlation to BTC beneath it. BTC itself is everyone's baseline: 0.0 / 1.00.
 */
function RelativeStrengthCell({ asset }: { asset: Asset }) {
  if (asset.rsBtc7d === undefined) return <span className="text-xs text-muted-foreground">—</span>;
  const rs = asset.rsBtc7d;
  return (
    <div>
      <div
        className={cn(
          "num text-sm font-semibold",
          rs > 0 ? "text-bullish" : rs < 0 ? "text-bearish" : "text-muted-foreground",
        )}
      >
        {rs > 0 ? "+" : ""}
        {rs.toFixed(1)}%
      </div>
      <div className="text-[10px] text-muted-foreground">
        {asset.corrBtc7d !== null && asset.corrBtc7d !== undefined
          ? `ρ ${asset.corrBtc7d.toFixed(2)}`
          : "ρ —"}
      </div>
    </div>
  );
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
  title,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  sortable?: boolean;
  active?: boolean;
  dir?: "asc" | "desc";
  onClick?: () => void;
  title?: string;
}) {
  return (
    <th
      title={title}
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
