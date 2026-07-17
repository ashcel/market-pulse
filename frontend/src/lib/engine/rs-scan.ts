import { createServerFn } from "@tanstack/react-start";

import { computePivots } from "./analysis";
import { fetchBinanceKlinesDirect } from "./binance";
import {
  DEFAULT_GATES,
  fetchTicker24hAll,
  percentiles,
  type ScanGates,
  type Ticker24h,
} from "./discovery";
import { UNIVERSE, WORKER_UNIVERSE } from "./market";
import { generateMockCandles } from "./mock-candles";
import { computeRelativeRead } from "./relative";
import { computeMarketStructure, type StructureTrend } from "./structure";
import { latestTransition, type TransitionPhase } from "./trend-transition";
import type { Candle } from "./types";

/**
 * Universe relative-strength scan — "who is actually leading or lagging BTC
 * across the whole liquid exchange, and is anyone mid-rotation?"
 *
 * Like discovery.ts this is a discovery layer outside the trading engine:
 * nothing here touches decision or trigger semantics, ENGINE_VERSION, or any
 * forward-test record. Unlike the opportunity scan it IS directional — RS
 * against BTC is signed — but it stays a ranking, never a verdict.
 *
 * Tiered against the rate budget:
 * - **Tier 1** (every gated pair): one full-exchange `/ticker/24hr` call
 *   (weight 80) → 24h RS vs BTC + its cross-sectional percentile.
 * - **Tier 2** (top/bottom `RS_ENRICH_COUNT` only): 1H klines for the exact
 *   `relative.ts` 7d RS convention, and 1D klines → market structure →
 *   latest trend transition, flagging rotation candidates among the
 *   leaders/laggards. ≈120 weight per scan against the 2000/min budget,
 *   behind a 10-minute cache — never fetch klines for every gated pair.
 */

export interface RsTransitionFlag {
  from: StructureTrend;
  to: StructureTrend;
  phase: TransitionPhase;
  /** Daily bars since the transition's latest phase advance. */
  barsAgo: number;
}

export interface RsRow {
  ticker: string;
  /** Display name when the token is in a tracked universe, else the ticker. */
  name: string;
  price: number;
  quoteVolume24h: number;
  /** In the curated dashboard UNIVERSE (has full snapshot coverage). */
  tracked: boolean;
  /** 24h % change minus BTC's — tier 1, present on every ranked pair. */
  rsBtc24h: number;
  /** Cross-sectional percentile of rsBtc24h within today's gated set. */
  rsPercentile24h: number;
  /** 168-hourly-bar RS spread (relative.ts convention); null when not enriched. */
  rsBtc7d: number | null;
  /** Latest daily-structure trend transition, when recent; null otherwise/not enriched. */
  transition: RsTransitionFlag | null;
}

export interface RsScan {
  source: "live" | "demo";
  updatedAt: string;
  /** Pairs that passed the gates and were RS-ranked (BTC itself excluded). */
  pairsRanked: number;
  /** Strongest vs BTC first (preferred = [0]). */
  leaders: RsRow[];
  /** Weakest vs BTC first. */
  laggards: RsRow[];
}

/** Rows enriched with 7d RS + transition flags, per side. */
export const RS_ENRICH_COUNT = 15;
/** A transition older than this many daily bars is history, not rotation. */
export const RS_TRANSITION_MAX_BARS = 30;

const DAY_SECONDS = 86_400;

const NAME_BY_TICKER = new Map(WORKER_UNIVERSE.map((u) => [u.ticker, u.name]));
const TRACKED_TICKERS = new Set(UNIVERSE.map((u) => u.ticker));

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Pure tier-1 core: gate exactly like the opportunity scan (absolute floors +
 * top liquidity tier), then rank everyone's 24h change against BTC's. BTC is
 * the yardstick, not a row. Sorted strongest-first with total tie-breaks
 * (spread → volume → ticker).
 */
export function computeRsRows(
  rows: Ticker24h[],
  btc: Ticker24h,
  gates: ScanGates = DEFAULT_GATES,
): RsRow[] {
  const gated = rows
    .filter(
      (r) =>
        r.ticker !== "BTC" &&
        r.quoteVolume24h >= gates.minQuoteVolume24h &&
        r.trades24h >= gates.minTrades24h &&
        r.lastPrice > 0,
    )
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h || a.ticker.localeCompare(b.ticker))
    .slice(0, gates.liquidityTierSize);

  const spreads = gated.map((r) => r.changePercent24h - btc.changePercent24h);
  const pcts = percentiles(spreads);

  return gated
    .map((row, i): RsRow => ({
      ticker: row.ticker,
      name: NAME_BY_TICKER.get(row.ticker) ?? row.ticker,
      price: row.lastPrice,
      quoteVolume24h: Math.round(row.quoteVolume24h),
      tracked: TRACKED_TICKERS.has(row.ticker),
      rsBtc24h: round(spreads[i]),
      rsPercentile24h: round(pcts[i], 0),
      rsBtc7d: null,
      transition: null,
    }))
    .sort(
      (a, b) =>
        b.rsBtc24h - a.rsBtc24h ||
        b.quoteVolume24h - a.quoteVolume24h ||
        a.ticker.localeCompare(b.ticker),
    );
}

/** The latest daily transition as a rotation flag; null when stale or absent. */
export function transitionFlag(daily: Candle[]): RsTransitionFlag | null {
  if (daily.length === 0) return null;
  const transition = latestTransition(computeMarketStructure(computePivots(daily)));
  if (!transition) return null;
  const lastTime = daily[daily.length - 1].time;
  const barsAgo = Math.max(0, Math.round((lastTime - transition.time) / DAY_SECONDS));
  if (barsAgo > RS_TRANSITION_MAX_BARS) return null;
  return { from: transition.from, to: transition.to, phase: transition.phase, barsAgo };
}

async function enrichRow(row: RsRow, btcHourly: Candle[]): Promise<void> {
  const [hourly, daily] = await Promise.all([
    fetchBinanceKlinesDirect({ symbol: row.ticker, timeframe: "1H", limit: 200 }),
    fetchBinanceKlinesDirect({ symbol: row.ticker, timeframe: "1D", limit: 150 }),
  ]);
  if (hourly.length > 0 && btcHourly.length > 0) {
    row.rsBtc7d = computeRelativeRead(hourly, btcHourly).rsBtc7d;
  }
  row.transition = transitionFlag(daily);
}

/**
 * Deterministic offline fallback over the worker universe, mirroring
 * buildDemoScan's stance: gates lifted (synthetic volumes aren't exchange
 * units), enrichment computed from the same mock series.
 */
export function buildDemoRsScan(): RsScan {
  const btcHourly = generateMockCandles("BTC", "1H");
  const btcDay = btcHourly.slice(-24);
  const btcChange =
    btcDay[0].open > 0
      ? ((btcDay[btcDay.length - 1].close - btcDay[0].open) / btcDay[0].open) * 100
      : 0;

  const rows = WORKER_UNIVERSE.filter((u) => u.ticker !== "BTC").map((entry): Ticker24h => {
    const hourly = generateMockCandles(entry.ticker, "1H");
    const day = hourly.slice(-24);
    const last = day[day.length - 1];
    const quoteVolume24h = day.reduce((sum, c) => sum + c.volume * c.close, 0);
    return {
      ticker: entry.ticker,
      lastPrice: last.close,
      changePercent24h: day[0].open > 0 ? ((last.close - day[0].open) / day[0].open) * 100 : 0,
      highPrice: Math.max(...day.map((c) => c.high)),
      lowPrice: Math.min(...day.map((c) => c.low)),
      weightedAvgPrice: day.reduce((sum, c) => sum + c.close, 0) / day.length,
      quoteVolume24h,
      trades24h: Math.max(1, Math.round(quoteVolume24h / 250)),
    };
  });
  const btcRow: Ticker24h = {
    ticker: "BTC",
    lastPrice: btcHourly[btcHourly.length - 1].close,
    changePercent24h: btcChange,
    highPrice: 0,
    lowPrice: 0,
    weightedAvgPrice: 0,
    quoteVolume24h: 0,
    trades24h: 0,
  };

  const ranked = computeRsRows(rows, btcRow, {
    minQuoteVolume24h: 0,
    minTrades24h: 0,
    liquidityTierSize: rows.length,
  });
  for (const side of [ranked.slice(0, RS_ENRICH_COUNT), ranked.slice(-RS_ENRICH_COUNT)]) {
    for (const row of side) {
      row.rsBtc7d = computeRelativeRead(generateMockCandles(row.ticker, "1H"), btcHourly).rsBtc7d;
      row.transition = transitionFlag(generateMockCandles(row.ticker, "1D"));
    }
  }

  return {
    source: "demo",
    updatedAt: new Date().toISOString(),
    pairsRanked: ranked.length,
    leaders: ranked.slice(0, RS_ENRICH_COUNT),
    laggards: ranked.slice(-RS_ENRICH_COUNT).reverse(),
  };
}

let scanCache: { at: number; data: RsScan } | null = null;
const RS_SCAN_TTL_MS = 600_000; // 7d RS moves slowly; 10min keeps ≈120 weight/scan trivial

async function computeRsScan(): Promise<RsScan> {
  const now = Date.now();
  if (scanCache && now - scanCache.at < RS_SCAN_TTL_MS) return scanCache.data;

  const rows = await fetchTicker24hAll();
  const btc = rows.find((r) => r.ticker === "BTC");
  // A near-empty parse means Binance was unreachable, not a quiet market.
  if (rows.length < 30 || !btc) return buildDemoRsScan();

  const ranked = computeRsRows(rows, btc);
  const leaders = ranked.slice(0, RS_ENRICH_COUNT);
  const laggards = ranked.slice(-RS_ENRICH_COUNT).reverse();

  const btcHourly = await fetchBinanceKlinesDirect({ symbol: "BTC", timeframe: "1H", limit: 200 });
  await Promise.all([...leaders, ...laggards].map((row) => enrichRow(row, btcHourly)));

  const scan: RsScan = {
    source: "live",
    updatedAt: new Date().toISOString(),
    pairsRanked: ranked.length,
    leaders,
    laggards,
  };
  scanCache = { at: now, data: scan };
  return scan;
}

export const fetchRsScanServer = createServerFn({ method: "GET" }).handler(computeRsScan);

/** Client-facing helper: server scan, falling back to the deterministic demo build. */
export async function fetchRsScan(): Promise<RsScan> {
  try {
    return await fetchRsScanServer();
  } catch {
    return buildDemoRsScan();
  }
}
