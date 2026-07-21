import { useMemo, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { AssetIcon } from "@/components/features/asset-icon";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { StatusBadge } from "@/components/features/status-badge";
import { SkeletonCard } from "@/components/features/skeletons";
import { Badge } from "@/components/ui/badge";
import { useFundingScan } from "@/hooks/queries";
import { cn } from "@/lib/utils";

type Tone = "bullish" | "bearish" | "warning" | "info" | "neutral";

const SHOWN = 6;

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
  verdict: "take" | "not-yet" | "skip";
  netEdgePct: number;
}) {
  const rateColor = fundingRatePct > 0 ? "text-bullish" : "text-bearish";
  const rateCaption = fundingRatePct > 0 ? "longs pay" : "shorts pay";
  const verdictTone: Tone =
    verdict === "take" ? "bullish" : verdict === "not-yet" ? "warning" : "bearish";

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
              harvest {side}
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
          {verdict}
        </StatusBadge>
      </Link>
    </li>
  );
}

export function FundingPlaysCard() {
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
          <CardEyebrow>Funding Plays</CardEyebrow>
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
          <CardEyebrow>Funding Plays</CardEyebrow>
          {data.source === "demo" && <StatusBadge tone="warning">Demo data</StatusBadge>}
        </div>
        <div className="border-t border-border px-5 py-4">
          <p className="text-sm text-muted-foreground">
            No extreme funding on the exchange right now (flag ≥0.5%/interval).
          </p>
        </div>
      </IqCard>
    );
  }

  return (
    <IqCard padded={false}>
      <div className="flex items-center justify-between p-5 pb-3">
        <CardEyebrow>Funding Plays</CardEyebrow>
        {data.source === "demo" && <StatusBadge tone="warning">Demo data</StatusBadge>}
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
        Harvest extreme funding when rates are ±0.5%/interval or higher — see each token for full
        hazards and what flips the verdict.
      </div>
    </IqCard>
  );
}
