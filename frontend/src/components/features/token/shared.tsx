import { CircleHelp } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TokenSignalData } from "@/hooks/useTokenSignal";
import type { MarketStructure } from "@/lib/engine/structure";
import type { SetupType, SignalEvaluation, TradeDirection } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import { formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="What is this?"
          className="text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <CircleHelp className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] bg-popover text-xs leading-relaxed text-popover-foreground shadow-lg">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
export function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="num mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}
export function biasLabel(
  timeframe: TokenTimeframe,
  direction: TradeDirection | undefined,
): string {
  if (direction === "long") return `${timeframe}: engine leans long`;
  if (direction === "short") return `${timeframe}: engine leans short`;
  return `${timeframe}: no directional bias`;
}
export function BiasDot({ direction }: { direction: TradeDirection | undefined }) {
  return (
    <span
      className={cn(
        "h-1 w-1 rounded-full",
        direction === "long" && "bg-bullish",
        direction === "short" && "bg-bearish",
        (direction === "none" || direction === undefined) && "bg-muted-foreground/30",
      )}
    />
  );
}
export function compute24hStats(candles: TokenSignalData["candles"]) {
  const lastCandle = candles.at(-1);
  if (!lastCandle) return null;
  const window = candles.filter((c) => c.time >= lastCandle.time - 24 * 60 * 60);
  if (window.length === 0) return null;
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
    volume: window.reduce((sum, c) => sum + c.volume, 0),
    turnover: window.reduce((sum, c) => sum + c.volume * c.close, 0),
  };
}
export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(
    value,
  );
}
/** One-glance summary of the swing structure for the chart header. */
export function structureReading(structure: MarketStructure): string {
  if (structure.trend === "uptrend") return "HH/HL uptrend";
  if (structure.trend === "downtrend") return "LH/LL downtrend";
  return "range structure";
}
/**
 * Passive premium/discount read of this chart timeframe's dealing range
 * (Phase 0 instrumentation — annotation only, no verdict behind it). Empty
 * until the engine has a range to measure against.
 */
export function equilibriumReading(evaluation: SignalEvaluation): string {
  const { dealingRange, pricePosition } = evaluation;
  if (!dealingRange || !pricePosition) return "";
  const range = `${formatMoney(dealingRange.low.price)}–${formatMoney(dealingRange.high.price)}`;
  return ` · ${pricePosition} of ${range}`;
}
export function humanSetup(setup: SetupType): string {
  return setup
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
export function RiskMetric({
  label,
  value,
  tone,
  compact,
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish";
  compact?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-surface", compact ? "p-2" : "p-2.5")}>
      <div
        className={cn(
          "font-semibold uppercase tracking-wider text-muted-foreground",
          compact ? "text-[9px] leading-tight" : "text-[10px]",
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 truncate font-semibold",
          compact ? "text-xs" : "text-sm",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value}
      </div>
    </div>
  );
}
export function LevelStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish";
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
      <span className="text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "num truncate text-[11px] font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value}
      </span>
    </div>
  );
}
export function ContextPill({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-2" title={title}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-xs font-semibold capitalize">{value}</div>
    </div>
  );
}
