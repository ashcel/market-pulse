import type { MarketRegimeData } from "../types";
import { seededRandom } from "./utils";

const rand = seededRandom(42);
const timeline = Array.from({ length: 60 }, (_, i) => {
  const value = 55 + Math.sin(i / 6) * 15 + (rand() - 0.5) * 8;
  return {
    t: i,
    value: Number(value.toFixed(1)),
    regime: value > 60 ? "Risk On" : value > 40 ? "Neutral" : "Risk Off",
  };
});

export const regime: MarketRegimeData = {
  regime: "Risk On",
  confidence: 89,
  trendStrength: "High",
  timeline,
  pillars: [
    {
      label: "Trend",
      score: 86,
      status: "bullish",
      description: "Broad uptrends across equities and crypto; 20/50 EMAs stacked long.",
    },
    {
      label: "Breadth",
      score: 78,
      status: "bullish",
      description: "72% of tracked assets above 50-day; advance/decline line rising.",
    },
    {
      label: "Volatility",
      score: 62,
      status: "neutral",
      description: "VIX 17.6 and compressed; realised vol below implied.",
    },
    {
      label: "Liquidity",
      score: 74,
      status: "bullish",
      description: "Global liquidity expanding; stablecoin supply +2.4% MoM.",
    },
    {
      label: "Macro",
      score: 58,
      status: "neutral",
      description: "Yields easing, growth data mixed, no imminent policy pivot.",
    },
  ],
};
