import { AlertTriangle, CalendarClock, TrendingDown, TrendingUp } from "lucide-react";

import { useCatalystImpact, type CatalystImpact } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import { InfoHint } from "@/components/features/token/shared";
import { getCatalystModifier } from "@/lib/catalyst/catalyst-modifier";
import type { TradingIntent } from "@/lib/engine/intent";

/** Compact "in 32h" / "6h ago" phrasing from a signed hours delta. */
function humanHours(hours: number): string {
  const abs = Math.abs(hours);
  if (abs < 1) return "under 1h";
  if (abs < 24) return `${Math.round(abs)}h`;
  return `${Math.round(abs / 24)}d`;
}

/** Title-case an event kind ("unlock" → "Unlock", "smart-contract" → "Smart Contract"). */
function titleCase(kind: string): string {
  return kind
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * How this event modifies the active objective's call — a plain-language,
 * direction-aware nudge, never a price claim (the impact score is a salience
 * ranking, not a forecast; see the disclaimer tooltip).
 */
const DIRECTION_STYLE: Record<
  CatalystImpact["direction"],
  { icon: typeof AlertTriangle; box: string }
> = {
  bearish: { icon: AlertTriangle, box: "border-bearish/30 bg-bearish-soft text-bearish" },
  bullish: { icon: TrendingUp, box: "border-bullish/30 bg-bullish-soft text-bullish" },
  neutral: { icon: CalendarClock, box: "border-warning/30 bg-warning-soft text-warning" },
};

/**
 * The catalyst line (§4.4 R1): one impact-scored, near-term catalyst rendered
 * as a one-liner that modifies the active objective's call, colored by the
 * event's direction prior. Silent whenever no medium-or-higher scored catalyst
 * is in window — it is an amendment to the verdict, not a permanent fixture.
 */
export function CatalystLine({
  symbol,
  activeIntentLabel,
  objective,
  direction,
}: {
  symbol: string;
  activeIntentLabel: string;
  objective: TradingIntent;
  direction: "long" | "short" | "none";
}) {
  const query = useCatalystImpact(symbol);
  const catalyst = query.data;
  if (query.isError) {
    return <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[11px] text-warning">Catalyst data unavailable</div>;
  }
  if (!catalyst) return null;

  const { icon: Icon, box } = DIRECTION_STYLE[catalyst.direction];
  const hours = (Date.parse(catalyst.occursAt) - Date.now()) / 3_600_000;
  const timePhrase = catalyst.isUpcoming ? `in ${humanHours(hours)}` : `${humanHours(hours)} ago`;
  const supply =
    catalyst.percentOfSupply != null
      ? ` (${(catalyst.percentOfSupply * 100).toFixed(1)}% supply)`
      : "";
  const result = direction === "none" ? null : getCatalystModifier(
    objective === "position" ? "swing" : objective,
    direction,
    [catalyst],
  );
  const ModifierIcon = result?.modifier === "tailwind" ? TrendingUp : result?.modifier === "headwind" ? TrendingDown : CalendarClock;
  const ageMinutes = Math.max(0, Math.round((Date.now() - query.dataUpdatedAt) / 60_000));

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] sm:px-2.5",
        box,
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p className="min-w-0 flex-1 leading-relaxed">
        <span className="font-semibold">
          {titleCase(catalyst.kind)} {timePhrase}
          {supply}
        </span>{" "}
        — {catalyst.direction}; {result ? `${result.modifier} · ${result.action} · ${result.sizing} size` : `select a direction for ${activeIntentLabel.toLowerCase()}`}
      </p>
      {result && <span className="flex shrink-0 items-center gap-1 rounded border border-current/30 px-1.5 py-0.5 font-semibold uppercase"><ModifierIcon className="h-3 w-3" />{result.modifier}</span>}
      <span className="shrink-0 text-[9px] opacity-70">fetched {ageMinutes}m ago</span>
      <span className="mt-0.5 shrink-0">
        <InfoHint text={catalyst.disclaimer} />
      </span>
    </div>
  );
}
