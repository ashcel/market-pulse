import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Clock } from "lucide-react";

import { AssetIcon } from "@/components/features/asset-icon";
import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import {
  formatCountdown,
  formatPct,
  formatTokenPrice,
  formatUsd,
  GradeBadge,
  ListingFlags,
  ScoreMeter,
  SinceLaunch,
  VenueLadder,
} from "@/components/features/listing-bits";
import { PageHeader } from "@/components/features/page-header";
import { SkeletonCard } from "@/components/features/skeletons";
import { StatusBadge } from "@/components/features/status-badge";
import { useListings, type ListingSort, type ListingSummary } from "@/hooks/useListings";
import { cn } from "@/lib/utils";

/**
 * The new-listing screener.
 *
 * Sorted the way the question is actually asked: **what lists next**, then
 * **what looks worth the attention**. Anything with a launch time still in
 * the future sorts above everything already trading, nearest first — that
 * pre-listing window is the entire reason this page exists — and everything
 * already trading falls back to the screener score.
 *
 * The score ranks attention, never direction. There is no buy signal here and
 * no position sizing; the deterministic gate, the evidence behind each score
 * and the risks are all shown so the reader can disagree with the ranking.
 */
export const Route = createFileRoute("/listings/")({
  head: () => ({
    meta: [
      { title: "New Listings — Market Pulse" },
      {
        name: "description",
        content:
          "Newly listed and upcoming Binance tokens — Alpha, spot and perpetual listings screened on liquidity, taker flow, holder concentration, unlock overhang and social pulse, with price tracked against the launch anchor.",
      },
    ],
  }),
  component: ListingsPage,
});

const SORTS: { key: ListingSort; labelKey: string }[] = [
  { key: "time", labelKey: "time" },
  { key: "score", labelKey: "score" },
  { key: "change", labelKey: "change" },
];

function CountdownChip({ hours }: { hours: number | null }) {
  const { t } = useTranslation();
  const label = formatCountdown(hours);
  if (label == null || hours == null) return null;

  const upcoming = hours > 0;
  const imminent = upcoming && hours <= 24;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        imminent
          ? "bg-bullish-soft text-bullish"
          : upcoming
            ? "bg-info-soft text-info"
            : "bg-muted text-muted-foreground",
      )}
    >
      <Clock className="h-3 w-3" aria-hidden="true" />
      {upcoming ? t("listings.listsIn", { time: label }) : t("listings.listedAgo", { time: label })}
    </span>
  );
}

function ListingRow({ row }: { row: ListingSummary }) {
  const { t } = useTranslation();

  return (
    <li>
      <Link
        to="/listings/$symbol"
        params={{ symbol: row.symbol }}
        className={cn(
          "block px-4 py-3.5 transition-colors hover:bg-surface",
          "focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
        )}
      >
        <div className="flex items-start gap-3">
          <AssetIcon ticker={row.symbol} className="mt-0.5 h-8 w-8 shrink-0" />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-semibold text-foreground">{row.symbol}</span>
              <span className="truncate text-xs text-muted-foreground">{row.name}</span>
              <GradeBadge grade={row.grade} />
              <CountdownChip hours={row.hoursToListing} />
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <VenueLadder row={row} />
              <ListingFlags row={row} />
              {row.chain && (
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {row.chain}
                </span>
              )}
            </div>

            {row.headline && (
              <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{row.headline}</p>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              <span className="num">
                {t("listings.price")} {formatTokenPrice(row.currentPrice)}
              </span>
              {row.percentChange24h != null && (
                <span
                  className={cn("num", row.percentChange24h > 0 ? "text-bullish" : "text-bearish")}
                >
                  {formatPct(row.percentChange24h)} {t("listings.in24h")}
                </span>
              )}
              {row.liquidity != null && (
                <span className="num">
                  {t("listings.liquidity")} {formatUsd(row.liquidity)}
                </span>
              )}
              {row.top10Pct != null && (
                <span className={cn("num", row.top10Pct > 0.6 && "text-warning")}>
                  {t("listings.top10")} {(row.top10Pct * 100).toFixed(0)}%
                </span>
              )}
              {row.warningCount > 0 && (
                <span className="inline-flex items-center gap-1 text-warning">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  {t("listings.warnings", { count: row.warningCount })}
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <ScoreMeter
              score={row.score}
              grade={row.grade}
              coverage={row.coverage}
              className="w-20 items-end"
            />
            <SinceLaunch pct={row.pctChangeSinceLaunch} source={row.launchPriceSource} />
          </div>
        </div>
      </Link>
    </li>
  );
}

function ListingsPage() {
  const { t } = useTranslation();
  const [sort, setSort] = useState<ListingSort>("time");
  const { data, isLoading, isError } = useListings({ sort, limit: 60 });

  const rows = data?.rows ?? [];
  const meta = data?.meta ?? null;
  const upcoming = rows.filter((row) => (row.hoursToListing ?? -1) > 0);
  const trading = rows.filter((row) => (row.hoursToListing ?? -1) <= 0);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-4 lg:pb-8">
      <PageHeader title={t("listings.title")} subtitle={t("listings.subtitle")} className="mb-4" />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div
          className="flex items-center gap-1 rounded-lg bg-muted p-1"
          role="group"
          aria-label={t("listings.sortAria")}
        >
          {SORTS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setSort(option.key)}
              aria-pressed={sort === option.key}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                sort === option.key
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`listings.sort.${option.labelKey}`)}
            </button>
          ))}
        </div>

        {meta && (
          <span className="text-[11px] text-muted-foreground">
            {t("listings.counts", { upcoming: meta.upcoming, trading: meta.trading })}
          </span>
        )}
      </div>

      {isLoading && <SkeletonCard />}

      {isError && (
        <IqCard>
          <p className="text-sm text-muted-foreground">{t("listings.loadFailed")}</p>
        </IqCard>
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <IqCard>
          <p className="text-sm text-muted-foreground">{t("listings.empty")}</p>
        </IqCard>
      )}

      {sort === "time" ? (
        <div className="flex flex-col gap-4">
          {upcoming.length > 0 && (
            <IqCard padded={false} className="overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
                <CardEyebrow>{t("listings.sectionUpcoming")}</CardEyebrow>
                <StatusBadge tone="info">{upcoming.length}</StatusBadge>
              </div>
              <ul className="divide-y divide-border border-t border-border">
                {upcoming.map((row) => (
                  <ListingRow key={row.symbol} row={row} />
                ))}
              </ul>
            </IqCard>
          )}

          {trading.length > 0 && (
            <IqCard padded={false} className="overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
                <CardEyebrow>{t("listings.sectionTrading")}</CardEyebrow>
                <StatusBadge tone="neutral">{trading.length}</StatusBadge>
              </div>
              <ul className="divide-y divide-border border-t border-border">
                {trading.map((row) => (
                  <ListingRow key={row.symbol} row={row} />
                ))}
              </ul>
            </IqCard>
          )}
        </div>
      ) : (
        rows.length > 0 && (
          <IqCard padded={false} className="overflow-hidden">
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <ListingRow key={row.symbol} row={row} />
              ))}
            </ul>
          </IqCard>
        )
      )}

      <p className="mt-4 px-1 text-[11px] leading-relaxed text-muted-foreground">
        {t("listings.disclaimer")}
      </p>
    </div>
  );
}
