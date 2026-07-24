import { Activity, Layers, Scale, ShieldAlert, ShieldCheck } from "lucide-react";

import { CardEyebrow } from "@/components/features/iq-card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import type { IntentAssessment } from "@/lib/engine/intent";
import type { PerpRead } from "@/lib/engine/perp";
import type { SessionLevel } from "@/lib/engine/sessions";
import { formatMoney } from "@/lib/utils/format";
import { computeLeverageMetrics, MAX_LEVERAGE, MIN_LEVERAGE } from "@/lib/utils/leverage";
import { cn } from "@/lib/utils";
import { InfoHint, RiskMetric, formatCompact } from "@/components/features/token/shared";

export function SessionLevelsCard({ levels, price }: { levels: SessionLevel[]; price: number }) {
  // The single high/low across all sessions that price is currently nearest —
  // the level most likely to act as immediate support/resistance.
  let nearestKey = "";
  let nearestDist = Infinity;
  for (const l of levels) {
    for (const kind of ["high", "low"] as const) {
      const p = kind === "high" ? l.high : l.low;
      const d = Math.abs(p - price);
      if (d < nearestDist) {
        nearestDist = d;
        nearestKey = `${l.session}-${kind}`;
      }
    }
  }

  const pill = (session: string, kind: "high" | "low", value: number) => {
    const deltaPct = ((value - price) / price) * 100;
    const highlight = nearestKey === `${session}-${kind}`;
    return (
      <div
        className={cn(
          "flex flex-1 items-baseline justify-between rounded-md border px-2 py-1",
          highlight
            ? "border-info/40 bg-info-soft text-info"
            : "border-border bg-card text-muted-foreground",
        )}
      >
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          {kind === "high" ? "H" : "L"}
        </span>
        <span className="num text-[11px] font-semibold">{formatMoney(value)}</span>
        <span className="num text-[9px]">
          {deltaPct >= 0 ? "+" : ""}
          {deltaPct.toFixed(1)}%
        </span>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center gap-1.5">
        <CardEyebrow>Session Levels</CardEyebrow>
        <InfoHint text="The high and low each trading region (Asia, London, New York) printed in its most recent completed session. Yesterday's session extremes are the intraday levels traders lean on — reclaiming a session high or holding a session low is a structure event. The level price is nearest is highlighted; the verdict's entry-location read counts a session level you're holding as structure." />
      </div>
      <div className="mt-2 space-y-1">
        {levels.map((l) => (
          <div key={l.session} className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-[10px] font-semibold text-foreground">
              {l.label}
            </span>
            {pill(l.session, "high", l.high)}
            {pill(l.session, "low", l.low)}
          </div>
        ))}
      </div>
    </div>
  );
}
export function PerpContextCard({ perp }: { perp: PerpRead }) {
  const fundingTone =
    perp.fundingBias === "neutral"
      ? "border-border bg-muted text-muted-foreground"
      : perp.fundingExtreme
        ? "border-bearish/30 bg-bearish-soft text-bearish"
        : "border-warning/30 bg-warning-soft text-warning";
  const fundingLabel =
    perp.fundingBias === "longs-crowded"
      ? "Longs crowded"
      : perp.fundingBias === "shorts-crowded"
        ? "Shorts crowded"
        : "Balanced";
  const apr = `${perp.fundingAnnualizedPct > 0 ? "+" : ""}${perp.fundingAnnualizedPct.toFixed(0)}%`;
  const oiTone =
    perp.oiTrend === "rising"
      ? "text-info"
      : perp.oiTrend === "falling"
        ? "text-muted-foreground"
        : "text-foreground";
  const oiChange = `${perp.oiChangePct > 0 ? "+" : ""}${perp.oiChangePct.toFixed(1)}%`;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <CardEyebrow>Perp Positioning</CardEyebrow>
          <InfoHint text="Funding + open interest — what perp traders check first. Positive funding means longs are paying to hold (crowded long, flush risk); negative means shorts are paying (crowded short, squeeze risk). Rising open interest means fresh money is behind the move; falling means positions are being closed. The verdict trims size when funding is extreme with the crowd already on your side." />
        </div>
        <Badge variant="outline" className={cn("shrink-0", fundingTone)}>
          {fundingLabel}
        </Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <div className="rounded-md border border-border bg-card px-2 py-1.5">
          <div className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            <Scale className="h-3 w-3" />
            Funding · 8h
          </div>
          <div className="num mt-0.5 text-sm font-semibold text-foreground">
            {(perp.fundingRate * 100).toFixed(4)}%
          </div>
          <div className="text-[10px] text-muted-foreground">{apr} annualized</div>
        </div>
        <div className="rounded-md border border-border bg-card px-2 py-1.5">
          <div className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            <Activity className="h-3 w-3" />
            Open interest
          </div>
          <div className="num mt-0.5 text-sm font-semibold text-foreground">
            {perp.openInterestValue > 0 ? `$${formatCompact(perp.openInterestValue)}` : "—"}
          </div>
          <div className={cn("text-[10px] font-medium", oiTone)}>{oiChange} · 24h</div>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{perp.note}</p>
    </div>
  );
}
export function LocationRow({
  location,
  support,
  resistance,
}: {
  location: NonNullable<DisplayIntentAssessment["location"]>;
  support: number | null;
  resistance: number | null;
}) {
  const tone =
    location.grade === "at-structure"
      ? { chip: "border-bullish/30 bg-bullish-soft text-bullish", marker: "bg-bullish" }
      : location.grade === "extended"
        ? { chip: "border-warning/30 bg-warning-soft text-warning", marker: "bg-warning" }
        : { chip: "border-info/30 bg-info-soft text-info", marker: "bg-info" };
  const pct = Math.round(Math.min(1, Math.max(0, location.rangePosition)) * 100);

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <CardEyebrow>Entry Location</CardEyebrow>
          <InfoHint text="Where price sits between support and resistance for this trade's direction. A long is best entered near support, a short near resistance — 'favored' is reserved for well-located setups, and an extended price becomes 'wait for a pullback' even when the direction is right." />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {location.confluence !== "none" && (
            <Badge
              variant="outline"
              className={cn(
                location.confluence === "multi-timeframe"
                  ? "border-bullish/40 bg-bullish-soft text-bullish"
                  : "border-info/30 bg-info-soft text-info",
              )}
            >
              <Layers className="mr-1 h-3 w-3" />
              {location.confluence === "multi-timeframe" ? "MTF confluence" : "Zone-backed"}
            </Badge>
          )}
          <Badge variant="outline" className={cn(tone.chip)}>
            {location.label}
          </Badge>
        </div>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-muted">
        <div
          className={cn("absolute -top-1 h-3.5 w-1 rounded-full", tone.marker)}
          style={{ left: `calc(${pct}% - 2px)` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>S {support !== null ? formatMoney(support) : "—"}</span>
        <span>R {resistance !== null ? formatMoney(resistance) : "—"}</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{location.note}</p>
    </div>
  );
}
export function PerpLeverage({
  plan,
  leverage,
  onLeverage,
}: {
  plan: NonNullable<IntentAssessment["plan"]>;
  leverage: number;
  onLeverage: (value: number) => void;
}) {
  const metrics = computeLeverageMetrics(
    plan.entry,
    plan.stop,
    plan.positionSize,
    plan.direction,
    leverage,
  );
  if (!metrics) return null;

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Leverage
          <InfoHint text="Leverage doesn't change the risk-sized position — the same units and max loss hold. It only sets the margin you post and where you'd be liquidated. Keep leverage at or below 'Max safe' so your stop triggers before liquidation. Liquidation is an estimate; it excludes fees and funding." />
        </span>
        <span className="num text-sm font-semibold text-foreground">{leverage}×</span>
      </div>
      <Slider
        min={MIN_LEVERAGE}
        max={MAX_LEVERAGE}
        step={1}
        value={[leverage]}
        onValueChange={([value]) => onLeverage(value)}
        aria-label="Leverage"
      />
      <div className="grid grid-cols-2 gap-1.5">
        <RiskMetric label="Margin" value={formatMoney(metrics.margin)} compact />
        <RiskMetric label="Notional" value={formatMoney(metrics.notional)} compact />
        <RiskMetric
          label="Est. liquidation"
          value={formatMoney(metrics.liquidation)}
          tone={metrics.liquidatesBeforeStop ? "bearish" : undefined}
          compact
        />
        <RiskMetric label="Max safe" value={`${metrics.maxSafeLeverage}×`} compact />
      </div>
    </div>
  );
}
/**
 * Leverage-aware invalidation check: does your stop (the trade's invalidation)
 * actually get to do its job, or does liquidation come first? At high leverage
 * the estimated liquidation can sit in front of the stop — the idea never even
 * gets the chance to be proven wrong. This reads out the current leverage's
 * verdict and, when unsafe, the leverage that restores a real stop.
 */
export function LiquidationCheck({
  plan,
  leverage,
}: {
  plan: NonNullable<IntentAssessment["plan"]>;
  leverage: number;
}) {
  const metrics = computeLeverageMetrics(
    plan.entry,
    plan.stop,
    plan.positionSize,
    plan.direction,
    leverage,
  );
  if (!metrics) return null;

  const bufferPct = Math.abs(metrics.stopToLiquidationBufferPct) * 100;
  const tone =
    metrics.liquidationSafety === "safe"
      ? { box: "border-bullish/30 bg-bullish-soft text-bullish", Icon: ShieldCheck }
      : metrics.liquidationSafety === "thin"
        ? { box: "border-warning/30 bg-warning-soft text-warning", Icon: ShieldAlert }
        : { box: "border-bearish/30 bg-bearish-soft text-bearish", Icon: ShieldAlert };

  const message =
    metrics.liquidationSafety === "danger" ? (
      <>
        At {leverage}× liquidation ({formatMoney(metrics.liquidation)}) triggers{" "}
        <strong>before</strong> your stop ({formatMoney(plan.stop)}) — you'd be liquidated before
        the idea is even invalidated. Drop to {metrics.maxSafeLeverage}× or lower so your stop does
        its job.
      </>
    ) : metrics.liquidationSafety === "thin" ? (
      <>
        Liquidation ({formatMoney(metrics.liquidation)}) sits only {bufferPct.toFixed(1)}% past your
        stop ({formatMoney(plan.stop)}) — a stop-run wick could liquidate you before the trade is
        invalidated. Consider {metrics.maxSafeLeverage}× or lower for more cushion.
      </>
    ) : (
      <>
        Your stop ({formatMoney(plan.stop)}) triggers first; liquidation (
        {formatMoney(metrics.liquidation)}) sits {bufferPct.toFixed(1)}% further out — a{" "}
        {metrics.bufferInStops.toFixed(1)}× stop-distance cushion. Invalidation stays in your
        control.
      </>
    );

  return (
    <div className={cn("flex items-start gap-2 rounded-lg border p-2.5", tone.box)}>
      <tone.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          Liquidation vs invalidation
        </span>
        <p className="mt-0.5 text-[11px] leading-relaxed">{message}</p>
      </div>
    </div>
  );
}
