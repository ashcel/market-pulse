import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AssetIcon } from "@/components/features/asset-icon";
import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { PATTERN_EVIDENCE_ORDER, PatternEvidenceRow } from "@/components/features/pattern-evidence";
import { SkeletonCard } from "@/components/features/skeletons";
import { StatusBadge } from "@/components/features/status-badge";
import { useReaccumulationScan, type ReaccumulationScanRow } from "@/hooks/useReaccumulation";
import { humanRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

const N = "components.reaccumulationScan.";

function ScanRow({ row }: { row: ReaccumulationScanRow }) {
  const { t } = useTranslation();
  const isSecondExpansion = row.state === "SECOND_EXPANSION";
  const stateLabel = isSecondExpansion
    ? t("components.reaccumulation.stateSecondExpansion")
    : t("components.reaccumulation.stateAccumulating");
  const directionLabel =
    row.direction === "long" ? t("components.reaccumulation.long") : t("components.reaccumulation.short");

  return (
    <li className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link
          to="/token/$symbol"
          params={{ symbol: row.symbol }}
          className="group flex min-w-0 items-center gap-2"
        >
          <AssetIcon ticker={row.symbol} className="h-6 w-6 shrink-0" />
          <span className="truncate text-sm font-semibold group-hover:text-info">{row.symbol}</span>
          <span className={cn("text-xs font-medium", row.direction === "long" ? "text-bullish" : "text-bearish")}>
            {directionLabel}
          </span>
        </Link>
        <StatusBadge tone={isSecondExpansion ? "bullish" : "warning"} className="shrink-0">
          {stateLabel}
        </StatusBadge>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("components.reaccumulation.score")}
        </span>
        <span className="num text-base font-semibold text-foreground">{Math.round(row.score)}</span>
        <span className="text-[10px] text-muted-foreground">/100</span>
        <span className="text-[10px] text-muted-foreground">· {humanRelative(row.detectedAt)}</span>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-foreground">{row.explanation}</p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {PATTERN_EVIDENCE_ORDER.map((key) => (
          <PatternEvidenceRow
            key={key}
            label={t(`components.reaccumulation.evidence.${key}`)}
            item={row.evidence[key]}
          />
        ))}
      </div>

      {!row.oiAvailable && (
        <p className="mt-2 text-[10px] italic text-muted-foreground">
          {t("components.reaccumulation.oiUnavailable")}
        </p>
      )}
    </li>
  );
}

/**
 * REACCUMULATION / SECOND EXPANSION screening card — every current candidate
 * (both states, score >= 40) across the hourly worker's dynamic scan
 * universe, ranked best-score-first. Reads persisted `signal_events` rows
 * only (`useReaccumulationScan`); never evaluates the universe live on page
 * load. Research hypotheses, not trade signals — same framing as the
 * token-page card.
 */
export function ReaccumulationScanCard() {
  const { t } = useTranslation();
  const { data } = useReaccumulationScan();

  if (!data) return <SkeletonCard height={280} />;

  return (
    <IqCard padded={false}>
      <div className="flex items-center justify-between p-4 pb-3 sm:p-5 sm:pb-3">
        <CardEyebrow>{t(`${N}title`)}</CardEyebrow>
      </div>
      <p className="px-4 pb-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
        {t(`${N}description`)}
      </p>

      {data.length === 0 ? (
        <div className="border-t border-border px-4 py-4 sm:px-5">
          <p className="text-sm text-muted-foreground">{t(`${N}emptyState`)}</p>
          <p className="mt-1 text-[10px] italic text-muted-foreground">{t(`${N}emptyStateNote`)}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {data.map((row) => (
            <ScanRow key={row.symbol} row={row} />
          ))}
        </ul>
      )}

      <div className="border-t border-border px-4 py-2 text-[10px] italic text-muted-foreground sm:px-5">
        {t(`${N}footer`)}
      </div>
    </IqCard>
  );
}
