import { CardEyebrow } from "@/components/iq/iq-card";
import type { AnticipatoryPlan } from "@/lib/engine/poi";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import { formatMoney } from "@/lib/format";

/**
 * Passive "if price pulls back" context next to the execution plan: the
 * limit-at-POI read — entry resting at a supply/demand zone, stop beyond its
 * wick extreme, target at the draw-on-liquidity objective, RR measured from
 * the limit price rather than the live price (EDR 0009). Display only: it is
 * never drawn on the chart (the chart's plan lines stay pinned to the active
 * objective's execution plan) and feeds no verdict. Callers render it only on
 * live data — a synthetic tape's zones are not levels anyone can rest an
 * order at.
 */
export function AnticipatoryReadCard({
  plan,
  timeframe,
}: {
  plan: AnticipatoryPlan;
  timeframe: TokenTimeframe;
}) {
  const zoneWord = `${plan.zone.freshness} ${timeframe} ${plan.zone.kind}`;
  const strengthWord =
    plan.objective.strength === "weak"
      ? `weak ${plan.direction === "long" ? "high" : "low"}`
      : `unresolved ${plan.direction === "long" ? "high" : "low"}`;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <CardEyebrow>If Price Pulls Back · Anticipatory</CardEyebrow>
        <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">
          ~{plan.rewardRisk.toFixed(1)}R from the limit
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        A resting {plan.direction} limit at <strong>{formatMoney(plan.entry)}</strong> ({zoneWord}
        {plan.entryPosition ? `, ${timeframe} ${plan.entryPosition}` : ""}), stop{" "}
        <strong>{formatMoney(plan.stop)}</strong> beyond the zone&apos;s wick, objective{" "}
        <strong>{formatMoney(plan.objective.price)}</strong> ({strengthWord}
        {plan.objective.pool ? ", pooled stops" : ""}). Reward/risk is measured from the limit
        price, not from where price trades now — this read is context, not a signal.
      </p>
    </div>
  );
}
