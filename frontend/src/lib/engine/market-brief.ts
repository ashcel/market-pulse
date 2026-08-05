import type {
  MarketRegimeData,
  RotationData,
  SentimentData,
  TechnicalData,
  VolatilityData,
} from "@/lib/types";

/**
 * The dashboard's market brief: three to five plain sentences describing the
 * tape, plus a one-line "how to trade it" derived from the same regime call.
 *
 * Deterministic and rule-based on purpose. It reads the snapshot fields the
 * dashboard already renders and restates them; it is **not** an LLM summary
 * and must never be labelled as one (the BYOK analyst is a separate, opt-in
 * surface). No new market judgement is formed here — the regime, rotation,
 * sentiment, technical and volatility calls are all made upstream.
 */

export type BriefTone = "bullish" | "bearish" | "neutral" | "warning";

export interface BriefLine {
  text: string;
  tone: BriefTone;
}

export interface MarketBrief {
  lines: BriefLine[];
  /** Short imperative chips: "Trade your plan", "Normal size"... */
  recommendation: string[];
}

export interface BriefInput {
  regime: MarketRegimeData;
  rotation: RotationData;
  sentiment: SentimentData;
  technical: TechnicalData;
  volatility: VolatilityData;
  /** High-impact macro prints inside the forward window, if any. */
  upcomingHighImpact: { title: string; occursAt: string }[];
  now?: number;
}

const RECOMMENDATION: Record<MarketRegimeData["regime"], string[]> = {
  "Risk On": ["Trade your plan", "Normal size", "Follow trend"],
  Neutral: ["Be selective", "Reduce size", "Skip low conviction"],
  "Risk Off": ["Sit out or scalp", "Tight risk", "No breakout chasing"],
};

function hoursUntil(iso: string, now: number): number {
  return (new Date(iso).getTime() - now) / 3_600_000;
}

export function buildMarketBrief(input: BriefInput): MarketBrief {
  const now = input.now ?? Date.now();
  const { regime, rotation, sentiment, technical, volatility } = input;
  const lines: BriefLine[] = [];

  const trend = regime.pillars.find((p) => p.label === "Trend");
  const breadth = regime.pillars.find((p) => p.label === "Breadth");

  lines.push({
    text: `${regime.regime} regime at ${regime.confidence}% rule confidence${
      trend ? `, trend ${String(trend.displayValue ?? trend.score).toLowerCase()}` : ""
    }.`,
    tone:
      regime.regime === "Risk On"
        ? "bullish"
        : regime.regime === "Risk Off"
          ? "bearish"
          : "neutral",
  });

  if (breadth) {
    lines.push({
      text: `Breadth ${breadth.score}% — ${
        breadth.score >= 60
          ? "participation is broad, moves have support"
          : breadth.score >= 40
            ? "participation is mixed, leadership is narrow"
            : "few names are participating, rallies are thin"
      }.`,
      tone: breadth.score >= 60 ? "bullish" : breadth.score >= 40 ? "neutral" : "bearish",
    });
  }

  if (rotation.flow.length > 0) {
    lines.push({
      text: `Capital rotating into ${rotation.winning}${
        rotation.losing ? ` out of ${rotation.losing}` : ""
      } — ${rotation.strength.toLowerCase()} rotation strength.`,
      tone: rotation.strength === "High" ? "bullish" : "neutral",
    });
  }

  lines.push({
    text: `Volatility ${volatility.label.toLowerCase()} at ${volatility.vix.toFixed(1)}% BTC ATR — ${
      volatility.label === "High"
        ? "wider stops and smaller size, or stand aside"
        : volatility.label === "Low"
          ? "supportive of continuation, but breakouts need real volume"
          : "normal conditions for planned entries"
    }.`,
    tone: volatility.label === "High" ? "warning" : "neutral",
  });

  lines.push({
    text: `Signal quality ${technical.label.toLowerCase()} (${technical.score}/100) and sentiment ${sentiment.label.toLowerCase()} at ${sentiment.score}/100${
      sentiment.source === "proxy" ? " (estimated)" : ""
    }.`,
    tone:
      technical.label === "Strong" ? "bullish" : technical.label === "Weak" ? "bearish" : "neutral",
  });

  const soon = input.upcomingHighImpact
    .map((e) => ({ ...e, h: hoursUntil(e.occursAt, now) }))
    .filter((e) => e.h > 0)
    .sort((a, b) => a.h - b.h);

  if (soon.length > 0) {
    const next = soon[0];
    lines.push({
      text: `${next.title} in ${next.h < 1 ? `${Math.round(next.h * 60)}m` : `${Math.round(next.h)}h`} — expect a volatility window around the print.`,
      tone: "warning",
    });
  } else {
    lines.push({ text: "No high-impact macro prints on the radar today.", tone: "neutral" });
  }

  const recommendation = [...RECOMMENDATION[regime.regime]];
  if (soon.length > 0) recommendation.push("Flat into the print");

  return { lines, recommendation };
}
