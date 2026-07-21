import { createServerFn } from "@tanstack/react-start";

import {
  DEFAULT_FUNDING_BACKTEST_CONFIG,
  runFundingBacktest,
  type FundingBacktestConfig,
  type FundingBacktestInstance,
  type FundingBacktestReport,
} from "./funding-backtest";
import { DEFAULT_FUNDING_PLAY_CONFIG } from "./funding-play";
import { binanceLimiter, klineWeight } from "./rate-limit";
import { futuresBaseToTicker, resolveExchangeSymbol } from "./symbol-map";
import type { Candle } from "./types";

/**
 * Fetch layer for the funding-harvest backtest — pulls a pair's historical
 * funding-rate settlements + the 1m klines bracketing each extreme one, then
 * runs the PURE `funding-backtest` simulation over them. Like `perp.ts` /
 * `discovery.ts` this is a read/serve helper: a `createServerFn` does the work
 * server-side (keeping `fetch`-heavy paging off the client) and a thin client
 * helper calls it. Nothing here touches decision/trigger semantics,
 * ENGINE_VERSION, or any forward-test record.
 *
 * Cost note: one backtest can fan out to ~100 kline calls (one window per
 * extreme instance), so results are cached server-side for ≥10 min per
 * symbol+config, and instance klines are fetched SEQUENTIALLY through the
 * shared `binanceLimiter` (never an unbounded Promise.all) so a single request
 * can't thundering-herd the Binance weight budget.
 */

const FAPI_BASE = "https://fapi.binance.com";

/** Default history lookback for the funding scan. */
const DEFAULT_LOOKBACK_DAYS = 180;
/** Never simulate more than the most-recent N extreme instances (cost cap). */
const MAX_INSTANCES = 100;
/** Extra minutes fetched on each side of the strategy window, for safety. */
const KLINE_BUFFER_MINUTES = 5;
/** Funding-rate history page size (Binance max). */
const FUNDING_PAGE_LIMIT = 1000;
/** Hard cap on funding-history pages walked, so a bad response can't loop. */
const MAX_FUNDING_PAGES = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** One historical funding settlement (raw, from /fapi/v1/fundingRate). */
export interface FundingRatePoint {
  /** Exchange pair, e.g. "SOLUSDT". */
  pair: string;
  /** Epoch ms of the settlement. */
  fundingTime: number;
  /** Settled funding rate as a decimal. */
  fundingRate: number;
}

/** The backtest report plus fetch provenance for the UI. */
export interface FundingBacktestResult {
  source: "live" | "demo";
  symbol: string;
  /** Exchange pair the history was pulled for. */
  pair: string;
  /** Lookback window actually requested, days. */
  lookbackDays: number;
  /** Extreme (|rate| ≥ flag threshold) settlements found in the window. */
  extremeCount: number;
  /** ISO timestamp the result was produced. */
  updatedAt: string;
  report: FundingBacktestReport;
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** App ticker for an exchange pair, undoing the 1000×-style futures rename. */
function pairToTicker(pair: string): string {
  const base = pair.endsWith("USDT") ? pair.slice(0, -4) : pair;
  return futuresBaseToTicker(base);
}

/**
 * Paginate the pair's funding-rate history back to `lookbackMs` before now.
 * Binance returns ascending pages of ≤1000; we walk forward from the lookback
 * start, advancing past the last settlement each page until it returns a short
 * (final) page or we hit `now`. Any failed page ends the walk with whatever was
 * collected so far (best-effort, never throws).
 */
export async function fetchFundingRateHistory(
  pair: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
  now: number = Date.now(),
): Promise<FundingRatePoint[]> {
  const startFrom = now - lookbackDays * DAY_MS;
  const out: FundingRatePoint[] = [];
  let start = startFrom;

  for (let page = 0; page < MAX_FUNDING_PAGES; page++) {
    let rows: Array<Record<string, unknown>>;
    try {
      // fundingRate history is a light call; treat it as weight 1 per page.
      await binanceLimiter.acquire(1);
      const params = new URLSearchParams({
        symbol: pair,
        startTime: String(Math.trunc(start)),
        endTime: String(Math.trunc(now)),
        limit: String(FUNDING_PAGE_LIMIT),
      });
      const res = await fetch(`${FAPI_BASE}/fapi/v1/fundingRate?${params.toString()}`);
      if (!res.ok) break;
      const payload = (await res.json()) as unknown;
      if (!Array.isArray(payload)) break;
      rows = payload as Array<Record<string, unknown>>;
    } catch {
      break;
    }

    if (rows.length === 0) break;
    for (const r of rows) {
      const fundingTime = num(r.fundingTime);
      const fundingRate = num(r.fundingRate);
      if (!Number.isFinite(fundingTime) || !Number.isFinite(fundingRate)) continue;
      out.push({ pair, fundingTime, fundingRate });
    }

    if (rows.length < FUNDING_PAGE_LIMIT) break;
    const lastTime = out.length > 0 ? out[out.length - 1].fundingTime : start;
    const nextStart = lastTime + 1;
    if (nextStart <= start || nextStart >= now) break;
    start = nextStart;
  }

  return out;
}

/**
 * Filter a funding-rate history to the extreme (|rate| ≥ flag threshold)
 * settlements, most recent first, capped at `MAX_INSTANCES`.
 */
export function selectExtremeInstances(
  points: FundingRatePoint[],
  extremeRate: number = DEFAULT_FUNDING_PLAY_CONFIG.extremeRate,
): FundingRatePoint[] {
  return points
    .filter((p) => Math.abs(p.fundingRate) >= extremeRate)
    .sort((a, b) => b.fundingTime - a.fundingTime)
    .slice(0, MAX_INSTANCES);
}

/** Parse a raw Binance /klines payload into Candle[] (time in SECONDS). */
function parseRawKlines(payload: unknown, priceScale: number): Candle[] {
  if (!Array.isArray(payload)) return [];
  const out: Candle[] = [];
  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const candle: Candle = {
      time: Math.floor(num(row[0]) / 1000),
      open: num(row[1]) / priceScale,
      high: num(row[2]) / priceScale,
      low: num(row[3]) / priceScale,
      close: num(row[4]) / priceScale,
      volume: num(row[5]) * priceScale,
    };
    if (Object.values(candle).every(Number.isFinite)) out.push(candle);
  }
  return out;
}

/**
 * Raw 1m klines covering [settlement − entryOffset − buffer, settlement +
 * reversalHold + buffer]. `fetchBinanceKlinesDirect` only supports the app's
 * chart timeframes (no 1m), so the backtest fetches raw fapi klines here with
 * startTime/endTime through the shared limiter (weight from `klineWeight`,
 * ~1 at this ~80-bar window). Price scale is applied for unit consistency,
 * though the backtest math is scale-invariant. `symbol` is the app ticker.
 */
async function fetchInstanceKlines(
  symbol: string,
  settlementMs: number,
  config: FundingBacktestConfig,
): Promise<Candle[]> {
  const { symbol: pair, priceScale } = resolveExchangeSymbol(symbol, "perp");
  if (pair === "USDT") return [];
  const startTime = settlementMs - (config.entryOffsetMinutes + KLINE_BUFFER_MINUTES) * MIN_MS;
  const endTime = settlementMs + (config.reversalHoldMinutes + KLINE_BUFFER_MINUTES) * MIN_MS;
  const spanMinutes = Math.ceil((endTime - startTime) / MIN_MS) + 2;
  const limit = Math.min(1000, Math.max(1, spanMinutes));
  try {
    await binanceLimiter.acquire(klineWeight(limit));
    const params = new URLSearchParams({
      symbol: pair,
      interval: "1m",
      startTime: String(Math.trunc(startTime)),
      endTime: String(Math.trunc(endTime)),
      limit: String(limit),
    });
    const res = await fetch(`${FAPI_BASE}/fapi/v1/klines?${params.toString()}`);
    if (!res.ok) return [];
    return parseRawKlines(await res.json(), priceScale);
  } catch {
    return [];
  }
}

/**
 * Compose the full backtest for one symbol: funding history → extreme
 * instances → per-instance klines → pure simulation. Sequential fetching
 * through the shared limiter. Returns a `demo`-sourced empty report when the
 * exchange is unreachable (no history), so the UI degrades gracefully.
 */
export async function computeFundingBacktest(
  symbol: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
  config: FundingBacktestConfig = DEFAULT_FUNDING_BACKTEST_CONFIG,
  now: number = Date.now(),
): Promise<FundingBacktestResult> {
  const { symbol: pair } = resolveExchangeSymbol(symbol, "perp");
  const ticker = pairToTicker(pair);

  const history = await fetchFundingRateHistory(pair, lookbackDays, now);
  const extreme = selectExtremeInstances(history, DEFAULT_FUNDING_PLAY_CONFIG.extremeRate);

  const instances: FundingBacktestInstance[] = [];
  for (const point of extreme) {
    // Sequential: each await returns before the next kline call is issued.
    const candles1m = await fetchInstanceKlines(ticker, point.fundingTime, config);
    if (candles1m.length < 2) continue;
    instances.push({
      pair,
      ticker,
      settlementMs: point.fundingTime,
      settledRate: point.fundingRate,
      intervalHours: 8, // history endpoint doesn't return the interval; harmless (unused in math)
      candles1m,
    });
  }

  const report = runFundingBacktest(pair, ticker, instances, config);
  return {
    // No live history at all ⇒ the exchange was unreachable, not "no extremes".
    source: history.length > 0 ? "live" : "demo",
    symbol,
    pair,
    lookbackDays,
    extremeCount: extreme.length,
    updatedAt: new Date(now).toISOString(),
    report,
  };
}

// ── Server-side cache (≥10 min per symbol+lookback) ───────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: FundingBacktestResult }>();

function cacheKey(symbol: string, lookbackDays: number): string {
  return `${symbol.toUpperCase()}|${lookbackDays}`;
}

async function computeCached(symbol: string, lookbackDays: number): Promise<FundingBacktestResult> {
  const key = cacheKey(symbol, lookbackDays);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await computeFundingBacktest(
    symbol,
    lookbackDays,
    DEFAULT_FUNDING_BACKTEST_CONFIG,
    now,
  );
  // Only cache live results — a demo (exchange-down) result should be retried.
  if (data.source === "live") cache.set(key, { at: now, data });
  return data;
}

export const fetchFundingBacktestServer = createServerFn({ method: "GET" })
  .validator((data: { symbol?: string; lookbackDays?: number }) => ({
    symbol: typeof data?.symbol === "string" ? data.symbol : "",
    lookbackDays:
      typeof data?.lookbackDays === "number" && Number.isFinite(data.lookbackDays)
        ? Math.min(365, Math.max(1, Math.trunc(data.lookbackDays)))
        : DEFAULT_LOOKBACK_DAYS,
  }))
  .handler(async ({ data }) => computeCached(data.symbol, data.lookbackDays));

/** Client helper: run (or read the cache of) the funding-harvest backtest. */
export async function fetchFundingBacktest(
  symbol: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
): Promise<FundingBacktestResult> {
  return fetchFundingBacktestServer({ data: { symbol, lookbackDays } });
}
