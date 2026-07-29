import type { ImpactDirection } from "@/hooks/queries";

export interface CatalystModifierEvent {
  impactScore: number;
  direction: ImpactDirection;
  occursAt: string;
  isUpcoming?: boolean;
}

export interface CatalystModifierResult {
  modifier: "tailwind" | "headwind" | "neutral";
  sizing: "reduce" | "normal" | "increase";
  action: "WAIT" | "PROCEED" | "CAUTION";
}

export function getCatalystModifier(
  objective: "scalp" | "intraday" | "swing",
  direction: "long" | "short",
  catalysts: CatalystModifierEvent[],
  now = Date.now(),
): CatalystModifierResult {
  const relevant = catalysts.filter((event) => event.direction !== "neutral");
  const strongest = [...relevant].sort((a, b) => b.impactScore - a.impactScore)[0];
  const imminentHighImpact = catalysts.some((event) => {
    const delay = Date.parse(event.occursAt) - now;
    return event.impactScore >= 7 && event.isUpcoming !== false && delay >= 0 && delay <= 2 * 60 * 60_000;
  });

  if (objective === "scalp" && imminentHighImpact) {
    return { modifier: "neutral", sizing: "reduce", action: "WAIT" };
  }
  if (!strongest) return { modifier: "neutral", sizing: "normal", action: "PROCEED" };

  const matches =
    (direction === "long" && strongest.direction === "bullish") ||
    (direction === "short" && strongest.direction === "bearish");
  return matches
    ? { modifier: "tailwind", sizing: "increase", action: "PROCEED" }
    : { modifier: "headwind", sizing: "reduce", action: "CAUTION" };
}
