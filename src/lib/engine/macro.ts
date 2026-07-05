import { createServerFn } from "@tanstack/react-start";

import { fetchBinanceKlinesDirect } from "./binance";

export type MacroInstrumentId = "spx" | "ndx" | "dxy" | "gold";
export type CorrelationRegime = "coupled" | "decoupled" | "inverse";

export interface MacroInstrument {
  id: MacroInstrumentId;
  label: string;
  last: number;
  changePercent: number;
  spark: number[];
}

export interface MacroSnapshot {
  instruments: MacroInstrument[];
  /** Pearson correlation of BTC vs Nasdaq 100 daily returns, ~30 shared sessions. */
  btcNdxCorrelation: number | null;
  correlationRegime: CorrelationRegime | null;
  source: "live" | "demo";
  updatedAt: string;
}

interface SeriesPoint {
  date: string;
  close: number;
}

const INSTRUMENT_LABELS: Record<MacroInstrumentId, string> = {
  spx: "S&P 500",
  ndx: "Nasdaq 100",
  dxy: "Dollar Index",
  gold: "Gold",
};

// FRED publishes these daily with a short lag and no API key; Yahoo/Stooq
// block datacenter IPs. Gold rides the Binance pipeline via PAXG (tokenized
// gold, tracks spot ~1:1) so it stays live even when FRED lags.
const FRED_SERIES: Record<Exclude<MacroInstrumentId, "gold">, string> = {
  spx: "SP500",
  ndx: "NASDAQ100",
  dxy: "DTWEXBGS",
};

const SPARK_POINTS = 30;
const CORRELATION_SESSIONS = 30;

async function fetchFredSeries(id: string): Promise<SeriesPoint[]> {
  const start = new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const response = await fetch(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`,
    );
    if (!response.ok) return [];
    const text = await response.text();
    return text
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        const [date, raw] = line.trim().split(",");
        const close = Number.parseFloat(raw);
        return date && Number.isFinite(close) ? [{ date, close }] : [];
      });
  } catch {
    return [];
  }
}

async function fetchBinanceDailySeries(symbol: string): Promise<SeriesPoint[]> {
  const candles = await fetchBinanceKlinesDirect({ symbol, timeframe: "1D", limit: 120 });
  return candles.map((c) => ({
    date: new Date(c.time * 1000).toISOString().slice(0, 10),
    close: c.close,
  }));
}

function toInstrument(id: MacroInstrumentId, series: SeriesPoint[]): MacroInstrument {
  const closes = series.map((p) => p.close);
  const last = closes.at(-1) ?? 0;
  const prev = closes.at(-2) ?? last;
  return {
    id,
    label: INSTRUMENT_LABELS[id],
    last: Number(last.toFixed(2)),
    changePercent: prev !== 0 ? Number((((last - prev) / prev) * 100).toFixed(2)) : 0,
    spark: closes.slice(-SPARK_POINTS).map((v) => Number(v.toFixed(2))),
  };
}

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Correlation of daily returns over the last ~30 sessions both markets traded.
 * Aligning on shared dates drops crypto's weekends so a closed stock market
 * never reads as divergence.
 */
export function computeBtcNdxCorrelation(btc: SeriesPoint[], ndx: SeriesPoint[]): number | null {
  const btcByDate = new Map(btc.map((p) => [p.date, p.close]));
  const shared = ndx.filter((p) => btcByDate.has(p.date)).slice(-(CORRELATION_SESSIONS + 1));
  if (shared.length < 11) return null;

  const btcReturns: number[] = [];
  const ndxReturns: number[] = [];
  for (let i = 1; i < shared.length; i++) {
    const prevBtc = btcByDate.get(shared[i - 1].date) as number;
    const curBtc = btcByDate.get(shared[i].date) as number;
    if (prevBtc === 0 || shared[i - 1].close === 0) continue;
    btcReturns.push(curBtc / prevBtc - 1);
    ndxReturns.push(shared[i].close / shared[i - 1].close - 1);
  }
  const value = pearson(btcReturns, ndxReturns);
  return value === null ? null : Number(value.toFixed(2));
}

export function correlationRegimeOf(correlation: number | null): CorrelationRegime | null {
  if (correlation === null) return null;
  if (correlation >= 0.4) return "coupled";
  if (correlation <= -0.3) return "inverse";
  return "decoupled";
}

// --- deterministic demo fallback (same philosophy as mock-candles) ---

const DEMO_BASE: Record<MacroInstrumentId, { base: number; volatility: number }> = {
  spx: { base: 7480, volatility: 0.008 },
  ndx: { base: 29500, volatility: 0.012 },
  dxy: { base: 121, volatility: 0.003 },
  gold: { base: 4170, volatility: 0.009 },
};

function demoSeries(id: string, base: number, volatility: number): SeriesPoint[] {
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const end = Date.UTC(2026, 6, 5);
  let close = base * (0.97 + rand() * 0.06);
  return Array.from({ length: 60 }, (_, i) => {
    close *= 1 + (rand() - 0.49) * volatility;
    return {
      date: new Date(end - (59 - i) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      close,
    };
  });
}

export function buildDemoMacroSnapshot(): MacroSnapshot {
  const series = Object.fromEntries(
    (Object.keys(DEMO_BASE) as MacroInstrumentId[]).map((id) => [
      id,
      demoSeries(id, DEMO_BASE[id].base, DEMO_BASE[id].volatility),
    ]),
  ) as Record<MacroInstrumentId, SeriesPoint[]>;
  const btcDemo = demoSeries("btc", 108_000, 0.02);
  const correlation = computeBtcNdxCorrelation(btcDemo, series.ndx);
  return {
    instruments: (Object.keys(DEMO_BASE) as MacroInstrumentId[]).map((id) =>
      toInstrument(id, series[id]),
    ),
    btcNdxCorrelation: correlation,
    correlationRegime: correlationRegimeOf(correlation),
    source: "demo",
    updatedAt: new Date().toISOString(),
  };
}

let macroCache: { at: number; data: MacroSnapshot } | null = null;
const MACRO_TTL_MS = 10 * 60_000;

async function computeMacroSnapshot(): Promise<MacroSnapshot> {
  const now = Date.now();
  if (macroCache && now - macroCache.at < MACRO_TTL_MS) return macroCache.data;

  const [spx, ndx, dxy, gold, btc] = await Promise.all([
    fetchFredSeries(FRED_SERIES.spx),
    fetchFredSeries(FRED_SERIES.ndx),
    fetchFredSeries(FRED_SERIES.dxy),
    fetchBinanceDailySeries("PAXG"),
    fetchBinanceDailySeries("BTC"),
  ]);

  const series: Record<MacroInstrumentId, SeriesPoint[]> = { spx, ndx, dxy, gold };
  const liveCount = Object.values(series).filter((s) => s.length >= 20).length;
  if (liveCount < 3) {
    const demo = buildDemoMacroSnapshot();
    macroCache = { at: now, data: demo };
    return demo;
  }

  const correlation =
    btc.length >= 20 && ndx.length >= 20 ? computeBtcNdxCorrelation(btc, ndx) : null;
  const snapshot: MacroSnapshot = {
    instruments: (Object.keys(INSTRUMENT_LABELS) as MacroInstrumentId[])
      .filter((id) => series[id].length >= 2)
      .map((id) => toInstrument(id, series[id])),
    btcNdxCorrelation: correlation,
    correlationRegime: correlationRegimeOf(correlation),
    source: "live",
    updatedAt: new Date().toISOString(),
  };
  macroCache = { at: now, data: snapshot };
  return snapshot;
}

export const fetchMacroSnapshotServer = createServerFn({ method: "GET" }).handler(async () =>
  computeMacroSnapshot(),
);

/** Client-facing helper: server snapshot, falling back to the deterministic demo build. */
export async function fetchMacroSnapshot(): Promise<MacroSnapshot> {
  try {
    return await fetchMacroSnapshotServer();
  } catch {
    return buildDemoMacroSnapshot();
  }
}
