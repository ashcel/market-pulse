export type Direction = "bullish" | "bearish" | "neutral";
export type Impact = "high" | "medium" | "low";
export type AssetCategory = "crypto" | "stocks" | "etf" | "commodity" | "fx" | "index";

export interface SparkPoint {
  t: number;
  v: number;
}

export interface Asset {
  id: string;
  ticker: string;
  name: string;
  category: AssetCategory;
  price: number;
  change24h: number;
  score: number;
  spark: SparkPoint[];
  momentum?: number;
  strength?: number;
  volume?: number;
  technical?: number;
  confidence?: number;
}

export interface MarketRegimeData {
  regime: "Risk On" | "Risk Off" | "Neutral";
  confidence: number;
  trendStrength: "High" | "Medium" | "Low";
  timeline: { t: number; value: number; regime: string }[];
  pillars: {
    label: string;
    score: number;
    status: Direction;
    description: string;
  }[];
}

export interface RotationLeg {
  from: string;
  to: string;
  strength: number;
}

export interface RotationData {
  flow: string[];
  legs: RotationLeg[];
  strength: "High" | "Medium" | "Low";
  confidence: number;
  winning: string;
  losing: string;
}

export interface Sector {
  name: string;
  group: "EQUITIES" | "CRYPTO" | "SECTORS" | "COMMODITIES" | "CURRENCIES";
  ticker: string;
  change: number;
}

export interface NewsItem {
  id: string;
  headline: string;
  impact: Impact;
  direction: Direction;
  assets: string[];
  minutesAgo: number;
  source: string;
  summary?: string;
}

export interface Signal {
  label: string;
  value: string;
  status: Direction | "neutral" | "warning";
  detail?: string;
}

export interface SentimentData {
  label: "Bullish" | "Bearish" | "Neutral";
  score: number;
  fearGreed: number;
}

export interface TechnicalData {
  label: "Strong" | "Weak" | "Mixed";
  score: number;
}

export interface VolatilityData {
  label: "Low" | "Medium" | "High";
  vix: number;
  change: number;
  spark: SparkPoint[];
}
