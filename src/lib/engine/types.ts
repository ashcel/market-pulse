export type ChartRange = "1d" | "1w" | "1m" | "6m" | "1y" | "5y" | "max";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PivotPoint {
  time: number;
  price: number;
  kind: "high" | "low";
}
