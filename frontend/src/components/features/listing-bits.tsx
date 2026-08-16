import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/features/status-badge";
import type { ListingGrade, ListingSummary } from "@/hooks/useListings";
import { cn } from "@/lib/utils";

/**
 * Small shared pieces for the listing screener: grade, countdown, venue
 * ladder, price formatting.
 *
 * Grade is encoded twice on purpose — colour *and* word — so the read never
 * depends on colour perception alone, and the score meter carries the same
 * hue so a row scans in one pass.
 */

export const GRADE_TONE: Record<ListingGrade, "bullish" | "info" | "warning" | "neutral"> = {
  PRIORITY: "bullish",
  WATCH: "info",
  THIN: "warning",
  SKIP: "neutral",
};

const GRADE_BAR: Record<ListingGrade, string> = {
  PRIORITY: "bg-bullish",
  WATCH: "bg-info",
  THIN: "bg-warning",
  SKIP: "bg-muted-foreground/40",
};

/** New listings routinely trade below a cent; a fixed 2dp would show "$0.00". */
export function formatTokenPrice(price: number | null): string {
  if (price == null || !Number.isFinite(price)) return "—";
  if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (price >= 1) return `$${price.toFixed(3)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  if (price >= 0.0001) return `$${price.toFixed(6)}`;
  return `$${price.toExponential(2)}`;
}

export function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function formatPct(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/** Hours to a signed, human countdown. Negative reads as time since listing. */
export function formatCountdown(hours: number | null): string | null {
  if (hours == null || !Number.isFinite(hours)) return null;
  const magnitude = Math.abs(hours);
  if (magnitude < 1) return `${Math.round(magnitude * 60)}m`;
  if (magnitude < 48) return `${Math.round(magnitude)}h`;
  return `${Math.round(magnitude / 24)}d`;
}

export function GradeBadge({
  grade,
  className,
}: {
  grade: ListingGrade | null;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!grade) return null;
  return (
    <StatusBadge tone={GRADE_TONE[grade]} className={className}>
      {t(`listings.grade.${grade}`)}
    </StatusBadge>
  );
}

/**
 * The score, as a number and a bar. Coverage is shown alongside because a
 * score computed off two of six components is a different claim from one
 * computed off all six, and hiding that would be the easiest way to mislead.
 */
export function ScoreMeter({
  score,
  grade,
  coverage,
  className,
}: {
  score: number | null;
  grade: ListingGrade | null;
  coverage: number | null;
  className?: string;
}) {
  const { t } = useTranslation();
  if (score == null) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        {t("listings.notScored")}
      </span>
    );
  }
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline gap-1">
        <span className="num text-lg font-semibold leading-none">{Math.round(score)}</span>
        <span className="text-[10px] text-muted-foreground">/100</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={t("listings.scoreAria", { score: Math.round(score), grade: grade ?? "" })}
      >
        <div
          className={cn("h-full rounded-full transition-[width]", GRADE_BAR[grade ?? "SKIP"])}
          style={{ width: `${pct}%` }}
        />
      </div>
      {coverage != null && (
        <span className="text-[10px] text-muted-foreground">
          {t("listings.coverage", { pct: Math.round(coverage * 100) })}
        </span>
      )}
    </div>
  );
}

/**
 * How far up Binance's ladder the token has climbed. Cumulative, so a perp
 * listing implies the rungs below it.
 */
export function VenueLadder({ row, className }: { row: ListingSummary; className?: string }) {
  const { t } = useTranslation();
  const rungs = [
    { key: "alpha", on: row.onAlpha },
    { key: "spot", on: row.onSpot },
    { key: "futures", on: row.onFutures },
  ] as const;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {rungs.map((rung) => (
        <span
          key={rung.key}
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            rung.on ? "bg-info-soft text-info" : "bg-muted text-muted-foreground/60",
          )}
        >
          {t(`listings.venue.${rung.key}`)}
        </span>
      ))}
    </div>
  );
}

/** The flags that change how a listing should be read, not just decorate it. */
export function ListingFlags({ row, className }: { row: ListingSummary; className?: string }) {
  const { t } = useTranslation();
  const flags: { key: string; tone: "bullish" | "warning" | "info" | "neutral" }[] = [];
  if (row.airdropLive) flags.push({ key: "airdrop", tone: "info" });
  if (row.tgeLive) flags.push({ key: "tge", tone: "info" });
  if (row.hotTag) flags.push({ key: "hot", tone: "bullish" });
  if (row.seedTag) flags.push({ key: "seed", tone: "warning" });
  if (flags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {flags.map((flag) => (
        <StatusBadge key={flag.key} tone={flag.tone}>
          {t(`listings.flag.${flag.key}`)}
        </StatusBadge>
      ))}
    </div>
  );
}

/**
 * Price against the frozen launch anchor. The anchor's provenance is shown
 * because "first traded price from an exchange kline" and "first price we
 * happened to observe" are different claims and the reader deserves to know
 * which one the percentage rests on.
 */
export function SinceLaunch({
  pct,
  source,
  className,
}: {
  pct: number | null;
  source: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  if (pct == null) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        {t("listings.noLaunchAnchor")}
      </span>
    );
  }
  return (
    <div className={cn("flex flex-col items-end", className)}>
      <span
        className={cn(
          "num text-sm font-semibold",
          pct > 0 ? "text-bullish" : pct < 0 ? "text-bearish" : "text-muted-foreground",
        )}
      >
        {formatPct(pct)}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {t("listings.sinceLaunch")}
        {source === "first_observed" ? ` · ${t("listings.anchorApprox")}` : ""}
      </span>
    </div>
  );
}
