import { useTranslation } from "react-i18next";

import { CardEyebrow } from "@/components/features/iq-card";
import { PATTERN_EVIDENCE_ORDER, PatternEvidenceRow } from "@/components/features/pattern-evidence";
import { StatusBadge } from "@/components/features/status-badge";
import { useReaccumulation } from "@/hooks/useReaccumulation";
import { cn } from "@/lib/utils";

interface ReaccumulationCardProps {
  symbol: string;
}

/**
 * REACCUMULATION / SECOND EXPANSION discovery card — a research hypothesis
 * read (`engine/smc/reaccumulation.py`), not a trade signal. Silently renders
 * nothing when the detector has no pattern (state NONE -> null), matching the
 * degrade convention of the other token-page discovery cards.
 */
export function ReaccumulationCard({ symbol }: ReaccumulationCardProps) {
  const { t } = useTranslation();
  const { data } = useReaccumulation(symbol);

  if (!data) return null;

  const isSecondExpansion = data.state === "SECOND_EXPANSION";
  const stateLabel = isSecondExpansion
    ? t("components.reaccumulation.stateSecondExpansion")
    : t("components.reaccumulation.stateAccumulating");
  const directionLabel =
    data.direction === "long"
      ? t("components.reaccumulation.long")
      : t("components.reaccumulation.short");

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <CardEyebrow className="flex-shrink-0">{t("tokenPage.reaccumulation.title")}</CardEyebrow>
          <span
            className={cn(
              "text-sm font-medium truncate",
              data.direction === "long" ? "text-bullish" : "text-bearish",
            )}
          >
            {directionLabel}
          </span>
        </div>
        <StatusBadge tone={isSecondExpansion ? "bullish" : "info"} className="shrink-0">
          {stateLabel}
        </StatusBadge>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("components.reaccumulation.score")}
        </span>
        <span className="num text-lg font-semibold text-foreground">{Math.round(data.score)}</span>
        <span className="text-xs text-muted-foreground">/100</span>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {PATTERN_EVIDENCE_ORDER.map((key) => (
          <PatternEvidenceRow
            key={key}
            label={t(`components.reaccumulation.evidence.${key}`)}
            item={data.evidence[key]}
          />
        ))}
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-foreground">{data.explanation}</p>

      {!data.oiAvailable && (
        <p className="mb-2 text-[10px] italic text-muted-foreground">
          {t("components.reaccumulation.oiUnavailable")}
        </p>
      )}

      <p className="text-[9px] italic text-muted-foreground">
        {t("components.reaccumulation.footer")}
      </p>
    </div>
  );
}
