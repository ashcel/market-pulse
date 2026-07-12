import type { Candle } from "./types";

/**
 * Relative strength + correlation vs BTC (roadmap A2/A3). Dashboard-plane
 * read models over the market snapshot's existing 1H series — display-only,
 * consumed by no engine decision path.
 */

export interface RelativeRead {
  /** Asset % change minus BTC % change over the last 24 hourly bars. */
  rsBtc24h: number;
  /** Asset % change minus BTC % change over the last 168 hourly bars. */
  rsBtc7d: number;
  /**
   * Pearson correlation of time-aligned hourly returns over up to the last
   * 168 bars; null below 48 overlapping returns (too little to be meaningful).
   */
  corrBtc7d: number | null;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** % change over the last `bars` bars — same convention as the snapshot's change24h/change7d. */
function changeOverBars(candles: Candle[], bars: number): number {
  const lastCandle = candles.at(-1);
  if (!lastCandle) return 0;
  const base = candles[Math.max(0, candles.length - 1 - bars)];
  if (!base || base.close === 0) return 0;
  return round(((lastCandle.close - base.close) / base.close) * 100, 2);
}

/** Pearson correlation; null when inputs are degenerate (zero variance / length mismatch / empty). */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const xs = a.slice(-n);
  const ys = b.slice(-n);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const CORR_WINDOW_BARS = 168;
const CORR_MIN_RETURNS = 48;

/**
 * Time-aligned hourly returns for two candle series: returns are computed
 * bar-over-bar per series, then paired strictly by bar open time so a gap or
 * length skew in one series can't shift the pairing.
 */
function alignedReturns(a: Candle[], b: Candle[]): { ra: number[]; rb: number[] } {
  const bReturnByTime = new Map<number, number>();
  for (let i = 1; i < b.length; i++) {
    if (b[i - 1].close !== 0) bReturnByTime.set(b[i].time, b[i].close / b[i - 1].close - 1);
  }
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < a.length; i++) {
    const other = bReturnByTime.get(a[i].time);
    if (other === undefined || a[i - 1].close === 0) continue;
    ra.push(a[i].close / a[i - 1].close - 1);
    rb.push(other);
  }
  return { ra: ra.slice(-CORR_WINDOW_BARS), rb: rb.slice(-CORR_WINDOW_BARS) };
}

/** The full relative read for one asset's 1H series against BTC's. */
export function computeRelativeRead(candles: Candle[], btcCandles: Candle[]): RelativeRead {
  const { ra, rb } = alignedReturns(candles, btcCandles);
  const corr = ra.length >= CORR_MIN_RETURNS ? pearson(ra, rb) : null;
  return {
    rsBtc24h: round(changeOverBars(candles, 24) - changeOverBars(btcCandles, 24)),
    rsBtc7d: round(changeOverBars(candles, 168) - changeOverBars(btcCandles, 168)),
    corrBtc7d: corr === null ? null : round(corr),
  };
}
