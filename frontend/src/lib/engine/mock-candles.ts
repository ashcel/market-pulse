import type { Candle } from "./types";

export const TOKEN_TIMEFRAMES = ["15M", "30M", "1H", "4H", "1D", "1W"] as const;

export type TokenTimeframe = (typeof TOKEN_TIMEFRAMES)[number];

export function isTokenTimeframe(value: unknown): value is TokenTimeframe {
  return TOKEN_TIMEFRAMES.includes(value as TokenTimeframe);
}

const BASE_PRICE: Record<string, number> = {
  BTC: 108_000,
  ETH: 5_600,
  SOL: 240,
  BNB: 920,
  XRP: 2.8,
  ADA: 1.15,
  DOGE: 0.32,
};

export const STEP_SECONDS: Record<TokenTimeframe, number> = {
  "15M": 15 * 60,
  "30M": 30 * 60,
  "1H": 60 * 60,
  "4H": 4 * 60 * 60,
  "1D": 24 * 60 * 60,
  "1W": 7 * 24 * 60 * 60,
};

const TIMEFRAME_VOLATILITY: Record<TokenTimeframe, number> = {
  "15M": 0.005,
  "30M": 0.007,
  "1H": 0.012,
  "4H": 0.018,
  "1D": 0.035,
  "1W": 0.07,
};

function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundPrice(value: number): number {
  if (value >= 1000) return Number(value.toFixed(2));
  if (value >= 10) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}

export function generateMockCandles(
  symbol: string,
  timeframe: TokenTimeframe,
  bars = 200,
): Candle[] {
  const ticker = symbol.toUpperCase();
  const rand = mulberry32(hashSeed(`${ticker}:${timeframe}`));
  const step = STEP_SECONDS[timeframe];
  const end = Math.floor(Date.UTC(2026, 6, 5, 0, 0, 0) / 1000);
  const base = BASE_PRICE[ticker] ?? 25 + (hashSeed(ticker) % 500);
  const volatility = TIMEFRAME_VOLATILITY[timeframe];
  const drift = (rand() - 0.46) * volatility * 0.35;
  const phase = rand() * Math.PI * 2;
  let close = base * (0.86 + rand() * 0.28);

  return Array.from({ length: bars }, (_, i) => {
    const time = end - (bars - 1 - i) * step;
    const cycle = Math.sin(i / 13 + phase) * volatility * 0.55;
    const shock = (rand() - 0.5) * volatility;
    const open = close;
    close = Math.max(base * 0.08, open * (1 + drift + cycle + shock));
    const wick = Math.max(open, close) * (0.004 + rand() * volatility * 0.7);
    const high = Math.max(open, close) + wick;
    const low = Math.max(0.00001, Math.min(open, close) - wick * (0.7 + rand() * 0.8));
    const volumeBase = 800_000 + (hashSeed(ticker) % 6_000_000);
    const volume = Math.round(volumeBase * (0.65 + rand() * 1.3) * (1 + Math.abs(cycle) * 12));

    return {
      time,
      open: roundPrice(open),
      high: roundPrice(high),
      low: roundPrice(low),
      close: roundPrice(close),
      volume,
    };
  });
}
