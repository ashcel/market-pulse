import type { Signal, SentimentData, TechnicalData, VolatilityData } from "../types";
import { makeSpark } from "./utils";

export const sentiment: SentimentData = {
  label: "Bullish",
  score: 72,
  fearGreed: 72,
};

export const technical: TechnicalData = {
  label: "Strong",
  score: 84,
};

export const volatility: VolatilityData = {
  label: "Medium",
  vix: 17.6,
  change: -3.21,
  spark: makeSpark(99, 40, -0.02, 0.015, 18.2),
};

export const signals: Signal[] = [
  { label: "Trend", value: "Bullish", status: "bullish", detail: "Higher highs on 4H and 1D" },
  {
    label: "Market Structure",
    value: "BOS",
    status: "bullish",
    detail: "Break of structure on 1H confirmed",
  },
  {
    label: "Liquidity Sweep",
    value: "Detected",
    status: "warning",
    detail: "Sell-side liquidity taken at 65.8K",
  },
  { label: "Order Block", value: "Active", status: "bullish", detail: "Demand OB from 64.2K holds" },
  { label: "EMA Alignment", value: "Strong", status: "bullish", detail: "20 > 50 > 200 stacked" },
  {
    label: "Volume",
    value: "Above Average",
    status: "bullish",
    detail: "1.8× 20-day average",
  },
  { label: "ATR", value: "Medium", status: "neutral", detail: "1,240 pts, in normal band" },
];

export const technicalConfidence = 87;
