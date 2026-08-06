import { useMemo, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { AssetIcon } from "@/components/features/asset-icon";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { StatusBadge } from "@/components/features/status-badge";
import { SkeletonCard } from "@/components/features/skeletons";
import { Badge } from "@/components/ui/badge";
import { useFundingScan } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import type { FundingPlayVerdict } from "@/lib/engine/funding-play";

type Tone = "bullish" | "bearish" | "warning" | "info" | "neutral";

const SHOWN = 6;

/**
 * Always-visible caution banner: this play was demoted from "advisor that
 * recommends" to "informational display" by product decision — the strategy
 * carries outsized risk (funding flips, squeeze risk, exchange/liquidation
 * risk) and the app does not recommend it. Shared by the dashboard card and
 * the token-page panel.
 */
export function FundingCautionBanner({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p className="text-[11px] leading-relaxed">
        <span className="font-semibold">{t("components.batchD.fundingPlays.notRecommended")}</span>{" "}
        {t("components.batchD.fundingPlays.cautionBody")}
      </p>
    </div>
  );
}

/** Neutral, non-actionable framing for the advisor's internal verdict tiers. */
export function verdictDisplay(
  verdict: FundingPlayVerdict,
  t: TFunction,
): { label: string; tone: Tone } {
  const n = "components.batchD.fundingPlays.";
  if (verdict === "take") return { label: t(`${n}verdictActive`), tone: "neutral" };
  if (verdict === "not-yet") return { label: t(`${n}verdictNotYet`), tone: "warning" };
  return { label: t(`${n}verdictSkip`), tone: "neutral" };
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}:${mins.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function FundingPlayRow({
  ticker,
  fundingRatePct,
  side,
  countdown,
  verdict,
  netEdgePct,
}: {
  ticker: string;
  fundingRatePct: number;
  side: "long" | "short";
  countdown: string;
  verdict: FundingPlayVerdict;
  netEdgePct: number;
}) {
  const { t } = useTranslation();
  const n = "components.batchD.fundingPlays.";
  const rateColor = fundingRatePct > 0 ? "text-bullish" : "text-bearish";
  const rateCaption = fundingRatePct > 0 ? t(`${n}longsPay`) : t(`${n}shortsPay`);
  const { label: verdictLabel, tone: verdictTone } = verdictDisplay(verdict, t);

  return (
    <li>
      <Link
        to="/token/$symbol"
        params={{ symbol: ticker }}
        className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface/60"
      >
        <AssetIcon ticker={ticker} className="h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className="text-sm font-semibold group-hover:text-info">{ticker}</span>
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] font-semibold uppercase",
                side === "long"
                  ? "border-bullish/30 bg-bullish-soft text-bullish"
                  : "border-bearish/30 bg-bearish-soft text-bearish",
              )}
            >
              {t(`${n}sideReceives`, { side })}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <span className={cn("font-semibold num", rateColor)}>{fundingRatePct.toFixed(2)}%</span>
            <span className="text-muted-foreground">{rateCaption}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground font-medium">{countdown}</span>
            <span className="ml-auto font-semibold text-foreground">{netEdgePct.toFixed(2)}%</span>
          </div>
        </div>
        <StatusBadge tone={verdictTone} className="shrink-0">
          {verdictLabel}
        </StatusBadge>
      </Link>
    </li>
  );
}

export function FundingPlaysCard() {
  const { t } = useTranslation();
  const n = "components.batchD.fundingPlays.";
  const { data } = useFundingScan();
  const [nowMs, setNowMs] = useState(Date.now());

  // Tick countdown every second
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const top = useMemo(() => data?.plays.slice(0, SHOWN) ?? [], [data]);

  if (!data) {
    return (
      <IqCard padded={false}>
        <div className="flex items-center justify-between p-5 pb-3">
          <CardEyebrow>{t(`${n}title`)}</CardEyebrow>
        </div>
        <div className="px-5 pb-3">
          <FundingCautionBanner />
        </div>
        <div className="p-5 pt-2">
          <SkeletonCard height={180} />
        </div>
      </IqCard>
    );
  }

  if (top.length === 0) {
    return (
      <IqCard padded={false}>
        <div className="flex items-center justify-between p-5 pb-3">
          <CardEyebrow>{t(`${n}title`)}</CardEyebrow>
          {data.source === "demo" && <StatusBadge tone="warning">{t(`${n}demoData`)}</StatusBadge>}
        </div>
        <div className="px-5 pb-3">
          <FundingCautionBanner />
        </div>
        <div className="border-t border-border px-5 py-4">
          <p className="text-sm text-muted-foreground">{t(`${n}emptyState`)}</p>
        </div>
      </IqCard>
    );
  }

  return (
    <IqCard padded={false}>
      <div className="flex items-center justify-between p-5 pb-3">
        <CardEyebrow>{t(`${n}title`)}</CardEyebrow>
        {data.source === "demo" && <StatusBadge tone="warning">{t(`${n}demoData`)}</StatusBadge>}
      </div>
      <div className="px-5 pb-3">
        <FundingCautionBanner />
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {top.map((play) => {
          const minutesToFunding = Math.max(0, play.minutesToFunding ?? 0);
          const countdown = formatCountdown(minutesToFunding * 60000);
          return (
            <FundingPlayRow
              key={`${play.ticker}-${play.side}`}
              ticker={play.ticker}
              fundingRatePct={play.fundingRate * 100}
              side={play.side}
              countdown={countdown}
              verdict={play.verdict}
              netEdgePct={play.netEdgePct}
            />
          );
        })}
      </ul>
      <div className="border-t border-border px-5 py-2 text-[11px] text-muted-foreground">
        {t(`${n}footer`)}
      </div>
    </IqCard>
  );
}
