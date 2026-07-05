import type { Candle, PivotPoint } from "./types";

export interface TrendLinePoint {
  time: number;
  value: number;
}

export interface TrendLines {
  support: TrendLinePoint[];
  resistance: TrendLinePoint[];
}

export function pivotWindow(candleCount: number): number {
  return Math.min(12, Math.max(3, Math.ceil(candleCount / 40)));
}

function isPivotAt(candles: Candle[], i: number, k: number, kind: "high" | "low"): boolean {
  const value = kind === "high" ? candles[i].high : candles[i].low;
  for (let j = i - k; j <= i + k; j++) {
    if (j === i) continue;
    const other = kind === "high" ? candles[j].high : candles[j].low;
    if (kind === "high" ? other > value : other < value) return false;
    if (other === value && j < i) return false;
  }
  return true;
}

function prominenceAt(candles: Candle[], i: number, k: number, price: number): number {
  let sum = 0;
  let count = 0;
  for (let j = i - k; j <= i + k; j++) {
    if (j === i) continue;
    sum += candles[j].close;
    count++;
  }
  if (count === 0) return 0;
  const mean = sum / count;
  let varSum = 0;
  for (let j = i - k; j <= i + k; j++) {
    if (j === i) continue;
    const d = candles[j].close - mean;
    varSum += d * d;
  }
  const stdev = Math.sqrt(varSum / count);
  return Math.abs(price - mean) / Math.max(stdev, 1e-8);
}

const MAX_PIVOTS = 8;

export function computePivots(candles: Candle[]): PivotPoint[] {
  const n = candles.length;
  const k = pivotWindow(n);
  if (n < 2 * k + 1) return [];

  const scored: { pivot: PivotPoint; prominence: number }[] = [];
  for (let i = k; i < n - k; i++) {
    if (isPivotAt(candles, i, k, "high")) {
      const price = candles[i].high;
      scored.push({
        pivot: { time: candles[i].time, price, kind: "high" },
        prominence: prominenceAt(candles, i, k, price),
      });
    }
    if (isPivotAt(candles, i, k, "low")) {
      const price = candles[i].low;
      scored.push({
        pivot: { time: candles[i].time, price, kind: "low" },
        prominence: prominenceAt(candles, i, k, price),
      });
    }
  }

  return scored
    .sort((a, b) => b.prominence - a.prominence)
    .slice(0, MAX_PIVOTS)
    .map((s) => s.pivot)
    .sort((a, b) => a.time - b.time || (a.kind === b.kind ? 0 : a.kind === "low" ? -1 : 1));
}

function projectLine(
  candles: Candle[],
  indexByTime: Map<number, number>,
  anchors: PivotPoint[],
): TrendLinePoint[] {
  if (anchors.length < 2) return [];
  const a = anchors[anchors.length - 2];
  const b = anchors[anchors.length - 1];
  const ia = indexByTime.get(a.time);
  const ib = indexByTime.get(b.time);
  if (ia === undefined || ib === undefined || ia === ib) return [];
  const slope = (b.price - a.price) / (ib - ia);
  const out: TrendLinePoint[] = [];
  for (let i = ia; i < candles.length; i++) {
    out.push({ time: candles[i].time, value: a.price + slope * (i - ia) });
  }
  return out;
}

export function computeTrendLines(candles: Candle[], pivots: PivotPoint[]): TrendLines {
  const indexByTime = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) indexByTime.set(candles[i].time, i);
  return {
    support: projectLine(
      candles,
      indexByTime,
      pivots.filter((p) => p.kind === "low"),
    ),
    resistance: projectLine(
      candles,
      indexByTime,
      pivots.filter((p) => p.kind === "high"),
    ),
  };
}
