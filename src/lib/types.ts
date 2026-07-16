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
  sector?: string;
  change7d?: number;
  quoteVolume24h?: number;
  decision?: string;
  setupType?: string;
  /** Relative strength vs BTC: this asset's % change minus BTC's, 24h / 7d. */
  rsBtc24h?: number;
  rsBtc7d?: number;
  /** Pearson correlation of hourly returns vs BTC over ≤7d; null when history is too thin. */
  corrBtc7d?: number | null;
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
    displayValue?: string;
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
  rankAgreement: number;
  winning: string;
  losing: string;
  winningChange?: number;
  losingChange?: number;
}

export interface Sector {
  name: string;
  group: string;
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
