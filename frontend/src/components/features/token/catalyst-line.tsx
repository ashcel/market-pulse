import { AlertTriangle, CalendarClock, TrendingUp } from "lucide-react";

import { useCatalystImpact, type CatalystImpact } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import { InfoHint } from "@/components/features/token/shared";

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
function modifier(direction: CatalystImpact["direction"], intentLabel: string): string {
  const intent = intentLabel.toLowerCase();
  if (direction === "bearish") return `${intent} entries size down`;
  if (direction === "bullish") return `tailwind for ${intent} longs`;
  return `expect volatility — mind ${intent} timing`;
}

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
}: {
  symbol: string;
  activeIntentLabel: string;
}) {
  const { data: catalyst } = useCatalystImpact(symbol);
  if (!catalyst) return null;

  const { icon: Icon, box } = DIRECTION_STYLE[catalyst.direction];
  const hours = (Date.parse(catalyst.occursAt) - Date.now()) / 3_600_000;
  const timePhrase = catalyst.isUpcoming ? `in ${humanHours(hours)}` : `${humanHours(hours)} ago`;
  const supply =
    catalyst.percentOfSupply != null
      ? ` (${(catalyst.percentOfSupply * 100).toFixed(1)}% supply)`
      : "";

  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px]", box)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p className="min-w-0 flex-1 leading-relaxed">
        <span className="font-semibold">
          {titleCase(catalyst.kind)} {timePhrase}
          {supply}
        </span>{" "}
        — {catalyst.direction}; {modifier(catalyst.direction, activeIntentLabel)}
      </p>
      <span className="mt-0.5 shrink-0">
        <InfoHint text={catalyst.disclaimer} />
      </span>
    </div>
  );
}
