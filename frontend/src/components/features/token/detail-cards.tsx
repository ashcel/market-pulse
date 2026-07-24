import {
  CheckCircle2,
  CircleAlert,
  CircleX,
  MoveRight,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { gradeRisk } from "@/lib/engine/quant";
import type {
  MarketRegime,
  SignalEvaluation,
  SignalStatus,
  TradeDirection,
} from "@/lib/engine/quant";
import { cn } from "@/lib/utils";

export function BiasCell({
  label,
  regime,
  bias,
}: {
  label: string;
  regime: MarketRegime;
  bias: TradeDirection;
}) {
  const Icon = bias === "long" ? TrendingUp : bias === "short" ? TrendingDown : MoveRight;
  return (
    <div className="rounded-md border border-border bg-card px-2 py-1.5">
      <div className="text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 flex items-center gap-1 truncate text-[11px] font-semibold capitalize",
          bias === "long" && "text-bullish",
          bias === "short" && "text-bearish",
        )}
      >
        {regime.replaceAll("-", " ")}
        <Icon className="h-3 w-3 shrink-0" />
      </div>
    </div>
  );
}
export interface InsightRow {
  label: string;
  value: string;
  tone: "bullish" | "bearish" | "warning" | "neutral";
  dir: "up" | "down" | "flat";
  /** Span the full grid row — for the structure summary, which needs the width. */
  wide?: boolean;
}
export function keyInsights(evaluation: SignalEvaluation): InsightRow[] {
  const a = evaluation.analytics;
  const trend: InsightRow =
    evaluation.regime === "trending-up"
      ? { label: "Trend", value: "Uptrend", tone: "bullish", dir: "up" }
      : evaluation.regime === "trending-down"
        ? { label: "Trend", value: "Downtrend", tone: "bearish", dir: "down" }
        : { label: "Trend", value: "Sideways", tone: "neutral", dir: "flat" };

  const aboveMean = a.sma20 !== null && a.lastClose > a.sma20;
  const momentum: InsightRow = aboveMean
    ? { label: "Momentum", value: "Positive", tone: "bullish", dir: "up" }
    : { label: "Momentum", value: "Weak", tone: "bearish", dir: "down" };

  const ratio = a.volumeRatio ?? 1;
  const volume: InsightRow =
    ratio >= 1.15
      ? { label: "Volume", value: "Above avg", tone: "bullish", dir: "up" }
      : ratio <= 0.85
        ? { label: "Volume", value: "Below avg", tone: "warning", dir: "down" }
        : { label: "Volume", value: "Average", tone: "neutral", dir: "flat" };

  // Same engine formula the Overview risk chip reads — the two can't diverge.
  const atrGrade = gradeRisk(a.atrPercent);
  const volatility: InsightRow =
    atrGrade === "high"
      ? { label: "Volatility (ATR)", value: "High", tone: "bearish", dir: "up" }
      : atrGrade === "medium"
        ? { label: "Volatility (ATR)", value: "Medium", tone: "warning", dir: "flat" }
        : { label: "Volatility (ATR)", value: "Low", tone: "neutral", dir: "flat" };

  // Swing structure is a separate read from the regime above: the regime is
  // MA/ATR-derived, structure is the HH/HL/LH/LL sequence of validated swing
  // legs. A break event is only news while it sits on the most recent swing.
  const s = evaluation.structure;
  const eventCurrent =
    s.event && s.eventSwing && (s.eventSwing === s.lastHigh || s.eventSwing === s.lastLow);
  const eventNote = eventCurrent ? (s.event === "bos" ? " · BOS" : " · CHoCH") : "";
  const structure: InsightRow =
    s.trend === "uptrend"
      ? {
          label: "Structure",
          value: `Higher highs & higher lows${eventNote}`,
          tone: "bullish",
          dir: "up",
          wide: true,
        }
      : s.trend === "downtrend"
        ? {
            label: "Structure",
            value: `Lower highs & lower lows${eventNote}`,
            tone: "bearish",
            dir: "down",
            wide: true,
          }
        : {
            label: "Structure",
            value: `Range — ${s.lastHigh?.label ?? "–"} high / ${s.lastLow?.label ?? "–"} low${eventNote}`,
            tone: "neutral",
            dir: "flat",
            wide: true,
          };

  return [trend, momentum, volume, volatility, structure];
}
export function KeyInsightBox({ label, value, tone, dir, wide }: InsightRow) {
  const DirIcon = dir === "up" ? TrendingUp : dir === "down" ? TrendingDown : MoveRight;
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-surface p-2",
        wide && "col-span-2 sm:col-span-4",
      )}
    >
      <div className="text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 flex items-center gap-1 truncate text-xs font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
        <DirIcon className="h-3 w-3 shrink-0" />
      </div>
    </div>
  );
}
export function StatusBadge({ status, score }: { status: SignalStatus; score: number }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "num shrink-0",
        status === "pass" && "border-bullish/30 bg-bullish-soft text-bullish",
        status === "warning" && "border-warning/30 bg-warning-soft text-warning",
        status === "fail" && "border-bearish/30 bg-bearish-soft text-bearish",
        status === "neutral" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {score >= 0 ? "+" : ""}
      {score}
    </Badge>
  );
}
export function StatusIcon({ status }: { status: SignalStatus }) {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4 shrink-0 text-bullish" />;
  if (status === "fail") return <CircleX className="h-4 w-4 shrink-0 text-bearish" />;
  if (status === "warning") return <CircleAlert className="h-4 w-4 shrink-0 text-warning" />;
  return <CircleAlert className="h-4 w-4 shrink-0 text-muted-foreground" />;
}
