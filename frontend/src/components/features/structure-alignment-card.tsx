import { CircleHelp, Minus, TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { CardEyebrow } from "@/components/features/iq-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TOKEN_TIMEFRAMES, type TokenTimeframe } from "@/lib/engine/mock-candles";
import { cn } from "@/lib/utils";
import type { MarketStructure, StructureTrend } from "@/lib/engine/structure";
import { latestTransition } from "@/lib/engine/trend-transition";

/**
 * Multi-timeframe structure alignment — surfaces the per-timeframe
 * `MarketStructure` the engine already computes for every timeframe (the same
 * alignment payload the worker and the decision assistant consume). Pure
 * display: reads existing evaluation output, feeds nothing back.
 */

function InfoHint({ text }: { text: string }) {
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

const TREND_META: Record<StructureTrend, { label: string; tone: string; Icon: typeof Minus }> = {
  uptrend: { label: "Uptrend", tone: "text-bullish", Icon: TrendingUp },
  downtrend: { label: "Downtrend", tone: "text-bearish", Icon: TrendingDown },
  range: { label: "Range", tone: "text-muted-foreground", Icon: Minus },
};

function eventChip(structure: MarketStructure) {
  if (!structure.event || !structure.eventSwing) {
    return <span className="text-[10px] text-muted-foreground">no break yet</span>;
  }
  // A break event always sits on the swing that broke structure: a swing high
  // breaking above prior structure is a bullish break, a swing low breaking
  // below is bearish (structure.ts classification).
  const bullish = structure.eventSwing.kind === "high";
  return (
    <Badge
      variant="outline"
      className={cn(
        "px-1.5 py-0 text-[9px] font-semibold uppercase",
        bullish
          ? "border-bullish/30 bg-bullish-soft text-bullish"
          : "border-bearish/30 bg-bearish-soft text-bearish",
      )}
    >
      {structure.event === "choch" ? "CHoCH" : "BOS"} {bullish ? "↑" : "↓"}
    </Badge>
  );
}

// The latest trend-transition read (display-only, EDR 0016): a confirmed flip
// shows its full narrative, a live CHoCH hint shows what it's waiting on.
function transitionChip(structure: MarketStructure) {
  const transition = latestTransition(structure);
  if (!transition) return null;
  const short: Record<StructureTrend, string> = {
    uptrend: "up",
    downtrend: "down",
    range: "range",
  };
  const confirmed = transition.phase === "confirmed";
  const toneUp = transition.to === "uptrend";
  return (
    <Badge
      variant="outline"
      className={cn(
        "px-1.5 py-0 text-[9px] font-semibold uppercase",
        confirmed
          ? toneUp
            ? "border-bullish/30 bg-bullish-soft text-bullish"
            : "border-bearish/30 bg-bearish-soft text-bearish"
          : "border-warning/30 bg-warning-soft text-warning",
      )}
    >
      {confirmed
        ? `${short[transition.from]}→${short[transition.to]}`
        : `${short[transition.to]}? awaiting confirm`}
    </Badge>
  );
}

export function StructureAlignmentCard({
  structures,
  contextTimeframe,
  executionTimeframe,
}: {
  structures: Partial<Record<TokenTimeframe, MarketStructure>>;
  /** The active objective's timeframes — highlighted so the ladder reads against the current intent. */
  contextTimeframe?: TokenTimeframe;
  executionTimeframe?: TokenTimeframe;
}) {
  const rows = TOKEN_TIMEFRAMES.map((tf) => ({ tf, structure: structures[tf] })).filter(
    (r): r is { tf: TokenTimeframe; structure: MarketStructure } => r.structure !== undefined,
  );
  if (rows.length === 0) return null;

  const up = rows.filter((r) => r.structure.trend === "uptrend").length;
  const down = rows.filter((r) => r.structure.trend === "downtrend").length;
  const summary =
    up === rows.length
      ? "aligned up"
      : down === rows.length
        ? "aligned down"
        : up >= down
          ? `${up}/${rows.length} up`
          : `${down}/${rows.length} down`;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <CardEyebrow>Structure Alignment</CardEyebrow>
          <InfoHint text="The swing structure (higher-highs/higher-lows vs lower-highs/lower-lows) on every timeframe at once, with the last structural break on each — BOS continues the trend, CHoCH is the first crack against it. Timeframes agreeing is what makes a with-trend objective payable; the two rows marked ctx and trig are the ones behind your current objective." />
        </div>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {summary}
        </span>
      </div>
      <div className="mt-2 space-y-1">
        {rows.map(({ tf, structure }) => {
          const meta = TREND_META[structure.trend];
          const roleTag =
            tf === executionTimeframe ? "trig" : tf === contextTimeframe ? "ctx" : null;
          return (
            <div
              key={tf}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1",
                roleTag ? "border-info/30 bg-info-soft/40" : "border-border bg-card",
              )}
            >
              <span className="num w-8 shrink-0 text-[10px] font-semibold text-foreground">
                {tf}
              </span>
              <meta.Icon className={cn("h-3 w-3 shrink-0", meta.tone)} />
              <span className={cn("w-20 shrink-0 text-[11px] font-medium", meta.tone)}>
                {meta.label}
              </span>
              <div className="flex flex-1 flex-wrap items-center gap-1">
                {eventChip(structure)}
                {transitionChip(structure)}
              </div>
              {roleTag && (
                <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-info">
                  {roleTag}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
