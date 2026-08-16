import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, ExternalLink } from "lucide-react";

import { AssetIcon } from "@/components/features/asset-icon";
import { HolderBubbleMap } from "@/components/features/holder-bubble-map";
import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { ListingAiAnalysis } from "@/components/features/listing-ai-analysis";
import {
  formatCountdown,
  formatPct,
  formatTokenPrice,
  formatUsd,
  GradeBadge,
  ListingFlags,
  ScoreMeter,
  VenueLadder,
} from "@/components/features/listing-bits";
import { ListingSocialPulse } from "@/components/features/listing-social-pulse";
import { SkeletonCard } from "@/components/features/skeletons";
import { useListingDetail, type ListingDetail, type PricePointRead } from "@/hooks/useListings";
import { cn } from "@/lib/utils";

/**
 * One listing, in full.
 *
 * Deliberately not the /token page: that page reads market structure on an
 * asset with history, which a token listed yesterday does not have. This one
 * answers the questions a *new* listing actually raises — who holds it, what
 * is still locked, who is buying it right now, what the crowd is saying, and
 * what it has done since its launch price.
 *
 * Every number here was computed by the worker. The page renders the record;
 * it never re-derives a score.
 */
export const Route = createFileRoute("/listings/$symbol")({
  head: ({ params }) => ({
    meta: [
      { title: `${params.symbol.toUpperCase()} listing — Market Pulse` },
      {
        name: "description",
        content: `Screener record for the ${params.symbol.toUpperCase()} Binance listing: score components, holder concentration, social pulse and price since launch.`,
      },
    ],
  }),
  component: ListingDetailPage,
});

/** Price since launch. The launch anchor is drawn as the baseline, because
 *  the only question this chart answers is "up or down from the start". */
function SinceLaunchChart({
  series,
  launchPrice,
}: {
  series: PricePointRead[];
  launchPrice: number | null;
}) {
  const { t } = useTranslation();
  if (series.length < 2 || launchPrice == null || launchPrice <= 0) return null;

  const prices = series.map((point) => point.price);
  const values = [...prices, launchPrice];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || max || 1;

  const width = 100;
  const height = 28;
  const x = (index: number) => (index / (series.length - 1)) * width;
  const y = (price: number) => height - ((price - min) / span) * height;

  const path = prices
    .map(
      (price, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(price).toFixed(2)}`,
    )
    .join(" ");
  const area = `${path} L${width},${height} L0,${height} Z`;
  const baseline = y(launchPrice);
  const last = prices[prices.length - 1];
  const up = last >= launchPrice;

  return (
    <div className="mt-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        role="img"
        aria-label={t("listings.detail.chartAria")}
      >
        <path d={area} className={up ? "fill-bullish/10" : "fill-bearish/10"} stroke="none" />
        <line
          x1="0"
          x2={width}
          y1={baseline}
          y2={baseline}
          className="stroke-muted-foreground/50"
          strokeWidth="0.4"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={path}
          fill="none"
          className={up ? "stroke-bullish" : "stroke-bearish"}
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={x(prices.length - 1)}
          cy={y(last)}
          r="1.6"
          className={up ? "fill-bullish" : "fill-bearish"}
        />
      </svg>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {t("listings.detail.chartCaption", { count: series.length })}
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish" | "warning";
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "num text-sm font-semibold text-foreground",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </span>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function VerdictCard({ listing }: { listing: ListingDetail }) {
  const { t } = useTranslation();

  if (listing.rejectedBecause) {
    return (
      <IqCard>
        <CardEyebrow>{t("listings.detail.verdict")}</CardEyebrow>
        <p className="mt-2 text-sm font-semibold text-foreground">
          {t("listings.detail.screenedOut")}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t(`listings.rejected.${listing.rejectedBecause}`, {
            defaultValue: t("listings.rejected.generic"),
          })}
        </p>
      </IqCard>
    );
  }

  return (
    <IqCard>
      <div className="flex items-start justify-between gap-4">
        <div>
          <CardEyebrow>{t("listings.detail.verdict")}</CardEyebrow>
          <p className="mt-1 text-xs text-muted-foreground">{t("listings.detail.verdictHint")}</p>
        </div>
        <ScoreMeter
          score={listing.score}
          grade={listing.grade}
          coverage={listing.coverage}
          className="w-28 items-end"
        />
      </div>

      {listing.components.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2.5">
          {listing.components.map((component) => (
            <li key={component.key}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                  {t(`listings.component.${component.key}`, { defaultValue: component.key })}
                </span>
                <span className="num text-[10px] text-muted-foreground">
                  {Math.round(component.score * 100)} · {t("listings.detail.weight")}{" "}
                  {Math.round(component.weight * 100)}%
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-info"
                  style={{ width: `${Math.round(component.score * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {component.evidence}
              </p>
            </li>
          ))}
        </ul>
      )}

      {listing.warnings.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3">
          {listing.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5">
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span className="text-[11px] leading-relaxed text-foreground">{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {listing.scoreVersion && (
        <p className="mt-3 text-[10px] text-muted-foreground">
          {t("listings.detail.scoreVersion", { version: listing.scoreVersion })}
        </p>
      )}
    </IqCard>
  );
}

function ListingDetailPage() {
  const { t } = useTranslation();
  const { symbol } = Route.useParams();
  const { data: listing, isLoading, isError } = useListingDetail(symbol);

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-4 lg:pb-8">
        <SkeletonCard />
      </div>
    );
  }

  if (isError || !listing) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-4 lg:pb-8">
        <IqCard>
          <p className="text-sm text-muted-foreground">
            {t("listings.detail.notFound", { symbol: symbol.toUpperCase() })}
          </p>
          <Link
            to="/listings"
            className="mt-3 inline-block text-xs font-semibold text-info hover:underline"
          >
            {t("listings.detail.back")}
          </Link>
        </IqCard>
      </div>
    );
  }

  const countdown = formatCountdown(listing.hoursToListing);
  const upcoming = (listing.hoursToListing ?? -1) > 0;
  const pct = listing.pctChangeSinceLaunch;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-4 lg:pb-8">
      <Link
        to="/listings"
        className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t("listings.detail.back")}
      </Link>

      <IqCard className="mb-4">
        <div className="flex items-start gap-3">
          <AssetIcon ticker={listing.symbol} className="h-11 w-11 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                {listing.symbol}
              </h1>
              <span className="truncate text-sm text-muted-foreground">{listing.name}</span>
              <GradeBadge grade={listing.grade} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <VenueLadder row={listing} />
              <ListingFlags row={listing} />
            </div>
            {listing.listingAt && countdown && (
              <p className="mt-2 text-xs text-muted-foreground">
                {upcoming
                  ? t("listings.detail.listsIn", {
                      time: countdown,
                      venue: listing.listingVenue ?? "Binance",
                    })
                  : t("listings.detail.listedAgo", {
                      time: countdown,
                      venue: listing.listingVenue ?? "Binance",
                    })}
              </p>
            )}
            {listing.announcementUrl && listing.announcementTitle && (
              <a
                href={listing.announcementUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2 inline-flex items-start gap-1 text-[11px] font-medium text-info hover:underline"
              >
                <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="line-clamp-2">{listing.announcementTitle}</span>
              </a>
            )}
          </div>
        </div>
      </IqCard>

      <IqCard className="mb-4">
        <CardEyebrow>{t("listings.detail.priceTitle")}</CardEyebrow>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label={t("listings.detail.current")}
            value={formatTokenPrice(listing.currentPrice)}
          />
          <Stat
            label={t("listings.detail.launch")}
            value={formatTokenPrice(listing.launchPrice)}
            hint={
              listing.launchPriceSource
                ? t(`listings.anchorSource.${listing.launchPriceSource}`, {
                    defaultValue: listing.launchPriceSource,
                  })
                : undefined
            }
          />
          <Stat
            label={t("listings.sinceLaunch")}
            value={formatPct(pct)}
            tone={pct == null ? undefined : pct > 0 ? "bullish" : "bearish"}
          />
          <Stat
            label={t("listings.detail.range")}
            value={`${formatTokenPrice(listing.minPriceSinceLaunch)} – ${formatTokenPrice(listing.maxPriceSinceLaunch)}`}
          />
        </div>
        <SinceLaunchChart series={listing.priceSeries} launchPrice={listing.launchPrice} />
      </IqCard>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <VerdictCard listing={listing} />

        <IqCard>
          <CardEyebrow>{t("listings.detail.marketTitle")}</CardEyebrow>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label={t("listings.detail.marketCap")} value={formatUsd(listing.marketCap)} />
            <Stat
              label={t("listings.detail.fdv")}
              value={formatUsd(listing.fdv)}
              hint={
                listing.fdv && listing.marketCap
                  ? t("listings.detail.fdvMultiple", {
                      multiple: (listing.fdv / listing.marketCap).toFixed(1),
                    })
                  : undefined
              }
            />
            <Stat label={t("listings.liquidity")} value={formatUsd(listing.liquidity)} />
            <Stat label={t("listings.detail.volume24h")} value={formatUsd(listing.volume24h)} />
            <Stat
              label={t("listings.detail.float")}
              value={
                listing.circulatingSupply && listing.totalSupply
                  ? `${((listing.circulatingSupply / listing.totalSupply) * 100).toFixed(0)}%`
                  : "—"
              }
              hint={t("listings.detail.floatHint")}
            />
            <Stat
              label={t("listings.detail.holders")}
              value={listing.holders != null ? listing.holders.toLocaleString() : "—"}
            />
          </div>
          {listing.chain && (
            <p className="mt-3 border-t border-border pt-2 text-[10px] text-muted-foreground">
              {t("listings.detail.chain", { chain: listing.chain })}
              {listing.contractAddress
                ? ` · ${listing.contractAddress.slice(0, 8)}…${listing.contractAddress.slice(-6)}`
                : ""}
            </p>
          )}
        </IqCard>
      </div>

      <HolderBubbleMap map={listing.holderMap} symbol={listing.symbol} className="mb-4" />

      <ListingSocialPulse pulse={listing.social} symbol={listing.symbol} className="mb-4" />

      <ListingAiAnalysis symbol={listing.symbol} className="mb-4" />

      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        {t("listings.disclaimer")}
      </p>
    </div>
  );
}
