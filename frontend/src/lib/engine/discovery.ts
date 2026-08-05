import { createServerFn } from "@tanstack/react-start";

import { dropUnclosedCandle, fetchBinanceKlinesDirect } from "./binance";
import { UNIVERSE, WORKER_UNIVERSE } from "./market";
import { generateMockCandles, type TokenTimeframe } from "./mock-candles";
import { binanceLimiter, TICKER_24H_ALL_WEIGHT } from "./rate-limit";
import { detectSpike, REF_WINDOW, RECENCY_WINDOW, type SpikeEvent } from "./spike";
import type { Candle } from "./types";

/**
 * Market-opportunity discovery — "which tokens are worth scanning right now?"
 *
 * Ranks EVERY liquid Binance USDT spot pair (not just the curated UNIVERSE) by
 * a blend of 24h volatility, liquidity, and trade activity, all read from one
 * full-exchange `/ticker/24hr` call. This is a discovery layer, not a signal:
 * it says "there is action here", never "long/short". It is deliberately
 * outside the trading engine — nothing here touches decision or trigger
 * semantics, ENGINE_VERSION, or any forward-test record.
 *
 * Thin pairs are handled three ways: a hard absolute floor removes dust
 * pairs entirely; only the exchange's top liquidity tier (most-traded pairs
 * by USDT turnover) is ranked at all, which keeps the candidate set honest in
 * hot and quiet tapes alike; and volatility credit inside the score is damped
 * by liquidity rank, so a barely-gated pair printing a 100% range still
 * cannot outrank a deep pair in a real expansion.
 */

/** One normalized row of Binance's 24h rolling ticker. */
export interface Ticker24h {
  /** Base asset, e.g. "SOL". */
  ticker: string;
  lastPrice: number;
  changePercent24h: number;
  highPrice: number;
  lowPrice: number;
  weightedAvgPrice: number;
  /** 24h turnover in USDT. */
  quoteVolume24h: number;
  /** Number of trades in the window. */
  trades24h: number;
}

export interface MarketOpportunity {
  ticker: string;
  /** Display name when the token is in a tracked universe, else the ticker. */
  name: string;
  price: number;
  change24h: number;
  /** 24h high-low span as % of the volume-weighted average price. */
  rangePercent24h: number;
  quoteVolume24h: number;
  trades24h: number;
  /** 0-100 blended scan score. */
  score: number;
  volatilityPercentile: number;
  liquidityPercentile: number;
  activityPercentile: number;
  /** In the curated dashboard UNIVERSE (has full snapshot coverage). */
  tracked: boolean;
  /** Human line for "why is this worth scanning" — never directional. */
  reason: string;
  /** Set when this pair just printed a vertical-spike-and-reject on the short TF. */
  spike?: SpikeEvent;
}

/** A pair currently showing a vertical-spike-and-reject — a discovery flag, not a call. */
export interface SpikeHit {
  ticker: string;
  name: string;
  price: number;
  tracked: boolean;
  spike: SpikeEvent;
}

export interface OpportunityScan {
  source: "live" | "demo";
  updatedAt: string;
  /** USDT pairs seen on the exchange before any filtering. */
  pairsSeen: number;
  /** Pairs that passed the liquidity/activity gates and were ranked. */
  pairsRanked: number;
  /**
   * Summed 24h USDT turnover across every pair seen — an exchange-wide
   * activity read for the dashboard's volume tile. Binance USDT only; it is
   * not global crypto volume and must never be labelled as such.
   */
  exchangeQuoteVolume24h: number;
  /** Ranked candidates, best first (preferred = [0]). */
  opportunities: MarketOpportunity[];
  /** Pairs across the whole liquidity tier currently in a spike-and-reject, heaviest volume first. */
  spikes: SpikeHit[];
}

export interface ScanGates {
  /** Minimum 24h USDT turnover — below this a pair is not a candidate at all. */
  minQuoteVolume24h: number;
  /** Minimum 24h trade count — screens out wash-y low-participation pairs. */
  minTrades24h: number;
  /**
   * After the absolute floors, only the N most liquid survivors are ranked.
   * This adapts the gate to the tape: on a quiet exchange the floor does the
   * work; on a hot one the tier keeps "liquid" meaning top-of-exchange.
   */
  liquidityTierSize: number;
}

export const DEFAULT_GATES: ScanGates = {
  minQuoteVolume24h: 5_000_000,
  minTrades24h: 10_000,
  liquidityTierSize: 100,
};

/**
 * Volatility leads (it is what makes a pair worth *scanning today*), but
 * liquidity + activity together outweigh it so movement alone never wins.
 */
export const SCORE_WEIGHTS = { volatility: 0.45, liquidity: 0.3, activity: 0.25 } as const;

const TOP_N = 12;

/**
 * Quote-stable, fiat, and pegged/wrapped bases: their "volatility" is either
 * ~zero or an artifact, and scanning them is never actionable.
 */
const EXCLUDED_BASES = new Set([
  "USDC",
  "FDUSD",
  "TUSD",
  "DAI",
  "USDP",
  "USDE",
  "USD1",
  "PYUSD",
  "BFUSD",
  "XUSD",
  "EUR",
  "EURI",
  "AEUR",
  "GBP",
  "TRY",
  "BRL",
  "ARS",
  "COP",
  "UAH",
  "PLN",
  "RON",
  "CZK",
  "MXN",
  "ZAR",
  "JPY",
  "WBTC",
  "WBETH",
  "BETH",
  "PAXG",
  "XAUT",
]);

// Legacy leveraged tokens (BTCUP, ETHDOWN, EOSBULL...). The ≥3-char prefix
// keeps real tickers like JUP from matching.
const LEVERAGED_BASE_RE = /^.{3,}(UP|DOWN|BULL|BEAR)$/;

function isScannableBase(base: string): boolean {
  return base.length > 0 && !EXCLUDED_BASES.has(base) && !LEVERAGED_BASE_RE.test(base);
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes the raw `/ticker/24hr` array to USDT-pair rows, dropping
 * non-USDT quotes, stables/fiat/wrapped/leveraged bases, and malformed rows.
 */
export function parseTicker24hAll(payload: unknown): Ticker24h[] {
  if (!Array.isArray(payload)) return [];
  const rows: Ticker24h[] = [];
  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const symbol = typeof r.symbol === "string" ? r.symbol : "";
    if (!symbol.endsWith("USDT")) continue;
    const base = symbol.slice(0, -4);
    if (!isScannableBase(base)) continue;

    const lastPrice = toFiniteNumber(r.lastPrice);
    const changePercent24h = toFiniteNumber(r.priceChangePercent);
    const highPrice = toFiniteNumber(r.highPrice);
    const lowPrice = toFiniteNumber(r.lowPrice);
    const weightedAvgPrice = toFiniteNumber(r.weightedAvgPrice);
    const quoteVolume24h = toFiniteNumber(r.quoteVolume);
    const trades24h = toFiniteNumber(r.count);
    if (
      lastPrice === null ||
      changePercent24h === null ||
      highPrice === null ||
      lowPrice === null ||
      weightedAvgPrice === null ||
      quoteVolume24h === null ||
      trades24h === null
    ) {
      continue;
    }
    rows.push({
      ticker: base,
      lastPrice,
      changePercent24h,
      highPrice,
      lowPrice,
      weightedAvgPrice,
      quoteVolume24h,
      trades24h,
    });
  }
  return rows;
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function rangePercent(row: Ticker24h): number {
  const anchor = row.weightedAvgPrice > 0 ? row.weightedAvgPrice : row.lastPrice;
  if (anchor <= 0 || row.highPrice < row.lowPrice) return 0;
  return ((row.highPrice - row.lowPrice) / anchor) * 100;
}

/** Rank-based percentile (0-100) of each value within its own set. */
export function percentiles(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 100);
  return values.map((v) => {
    let below = 0;
    for (const other of values) if (other < v) below++;
    return (below / (n - 1)) * 100;
  });
}

const NAME_BY_TICKER = new Map(WORKER_UNIVERSE.map((u) => [u.ticker, u.name]));
const TRACKED_TICKERS = new Set(UNIVERSE.map((u) => u.ticker));

function buildReason(volPct: number, liqPct: number, actPct: number): string {
  const parts: string[] = [];
  if (volPct >= 85) parts.push("outsized 24h range");
  else if (volPct >= 60) parts.push("elevated 24h range");
  if (liqPct >= 85) parts.push("deep liquidity");
  else if (liqPct >= 60) parts.push("solid liquidity");
  if (actPct >= 85) parts.push("very heavy trade flow");
  else if (actPct >= 60) parts.push("busy tape");
  const text = parts.length > 0 ? parts.join(" · ") : "balanced liquidity and movement";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Pure, deterministic ranking of gated candidates. Percentile scoring is
 * self-calibrating: "volatile" means volatile relative to today's liquid
 * pairs, so the list stays meaningful in quiet and wild tapes alike.
 * Returns the FULL ranked list — callers slice for display.
 */
export function scoreOpportunities(
  rows: Ticker24h[],
  gates: ScanGates = DEFAULT_GATES,
): MarketOpportunity[] {
  const gated = rows
    .filter(
      (r) =>
        r.quoteVolume24h >= gates.minQuoteVolume24h &&
        r.trades24h >= gates.minTrades24h &&
        r.lastPrice > 0,
    )
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h || a.ticker.localeCompare(b.ticker))
    .slice(0, gates.liquidityTierSize);

  const volPcts = percentiles(gated.map(rangePercent));
  // Log-scaled so a $2B pair doesn't flatten every mid-cap to zero.
  const liqPcts = percentiles(gated.map((r) => Math.log10(Math.max(1, r.quoteVolume24h))));
  const actPcts = percentiles(gated.map((r) => Math.log10(Math.max(1, r.trades24h))));

  const scored = gated.map((row, i): MarketOpportunity => {
    const volPct = volPcts[i];
    const liqPct = liqPcts[i];
    const actPct = actPcts[i];
    // Volatility credit scales with liquidity rank (×0.5 at the bottom of the
    // tier, ×1 at the top): a wild range on a barely-gated pair earns half
    // what the same range earns on a deep one.
    const dampedVol = volPct * (0.5 + liqPct / 200);
    const score =
      SCORE_WEIGHTS.volatility * dampedVol +
      SCORE_WEIGHTS.liquidity * liqPct +
      SCORE_WEIGHTS.activity * actPct;
    return {
      ticker: row.ticker,
      name: NAME_BY_TICKER.get(row.ticker) ?? row.ticker,
      price: row.lastPrice,
      change24h: round(row.changePercent24h, 2),
      rangePercent24h: round(rangePercent(row), 2),
      quoteVolume24h: Math.round(row.quoteVolume24h),
      trades24h: Math.round(row.trades24h),
      score: round(score, 1),
      volatilityPercentile: round(volPct),
      liquidityPercentile: round(liqPct),
      activityPercentile: round(actPct),
      tracked: TRACKED_TICKERS.has(row.ticker),
      reason: buildReason(volPct, liqPct, actPct),
    };
  });

  return scored.sort(
    (a, b) =>
      b.score - a.score || b.quoteVolume24h - a.quoteVolume24h || a.ticker.localeCompare(b.ticker),
  );
}

/** Exchange-wide 24h USDT turnover across the rows given. */
export function sumQuoteVolume(rows: Ticker24h[]): number {
  return Math.round(rows.reduce((sum, r) => sum + (r.quoteVolume24h || 0), 0));
}

/**
 * Deterministic offline fallback built from the same mock candles the rest of
 * the app degrades to. Gates are lifted because synthetic volumes aren't in
 * real-exchange units — the demo exists to exercise the surface, not the gate.
 */
export function buildDemoScan(): OpportunityScan {
  const rows = WORKER_UNIVERSE.map((entry): Ticker24h => {
    const day = generateMockCandles(entry.ticker, "1H").slice(-24);
    const last = day[day.length - 1];
    const first = day[0];
    const quoteVolume24h = day.reduce((sum, c) => sum + c.volume * c.close, 0);
    return {
      ticker: entry.ticker,
      lastPrice: last.close,
      changePercent24h: first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0,
      highPrice: Math.max(...day.map((c) => c.high)),
      lowPrice: Math.min(...day.map((c) => c.low)),
      weightedAvgPrice: day.reduce((sum, c) => sum + c.close, 0) / day.length,
      quoteVolume24h,
      trades24h: Math.max(1, Math.round(quoteVolume24h / 250)),
    };
  });
  const opportunities = scoreOpportunities(rows, {
    minQuoteVolume24h: 0,
    minTrades24h: 0,
    liquidityTierSize: rows.length,
  });
  return {
    source: "demo",
    updatedAt: new Date().toISOString(),
    pairsSeen: rows.length,
    pairsRanked: rows.length,
    exchangeQuoteVolume24h: sumQuoteVolume(rows),
    opportunities: opportunities.slice(0, TOP_N),
    // Spike detection needs real short-TF klines; the offline build never
    // fabricates them, so the demo surface simply carries no spikes.
    spikes: [],
  };
}

export async function fetchTicker24hAll(): Promise<Ticker24h[]> {
  try {
    await binanceLimiter.acquire(TICKER_24H_ALL_WEIGHT);
    const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (!response.ok) return [];
    return parseTicker24hAll(await response.json());
  } catch {
    return [];
  }
}

/** The full ranked liquidity tier + provenance — the shared basis both the
 * public scan and the spike scan are derived from, cached once. */
interface RankedScan {
  source: "live" | "demo";
  updatedAt: string;
  pairsSeen: number;
  /** Summed 24h USDT turnover across every pair seen. */
  exchangeQuoteVolume24h: number;
  /** FULL ranked list (not sliced) — spike scanning walks the whole tier. */
  ranked: MarketOpportunity[];
}

let scanCache: { at: number; data: RankedScan } | null = null;
const SCAN_TTL_MS = 120_000;

async function computeRankedScan(): Promise<RankedScan> {
  const now = Date.now();
  if (scanCache && now - scanCache.at < SCAN_TTL_MS) return scanCache.data;

  const rows = await fetchTicker24hAll();
  // A near-empty parse means Binance was unreachable or degraded, not that
  // the market went quiet — fall back to demo rather than an empty list.
  if (rows.length < 30) {
    const demo = buildDemoScan();
    return {
      source: "demo",
      updatedAt: demo.updatedAt,
      pairsSeen: demo.pairsSeen,
      exchangeQuoteVolume24h: demo.exchangeQuoteVolume24h,
      ranked: demo.opportunities,
    };
  }

  const ranked = scoreOpportunities(rows);
  const data: RankedScan = {
    source: "live",
    updatedAt: new Date().toISOString(),
    pairsSeen: rows.length,
    exchangeQuoteVolume24h: sumQuoteVolume(rows),
    ranked,
  };
  scanCache = { at: now, data };
  return data;
}

// --- Spike scan -----------------------------------------------------------
// A vertical-spike-and-reject is invisible to the 24h ticker (no timing), so
// it needs short-TF klines per pair. That is far too heavy to run inline on a
// page load, so it is decoupled: a background refresh (driven by the server
// spike-watch on a timer, and lazily kicked by page loads) walks the tier and
// caches the hits; the public scan only ever *reads* that cache. Each kline
// fetch is weight 1 and routed through the shared limiter, so the whole tier
// costs a small, staggered fraction of the Binance budget per refresh.

const SPIKE_TIMEFRAME: TokenTimeframe = "15M";
const SPIKE_KLINE_LIMIT = REF_WINDOW + RECENCY_WINDOW + 5;
const SPIKE_TTL_MS = 90_000;

/** Injectable so tests can drive detection without touching the network. */
export type KlineFetcher = (ticker: string) => Promise<Candle[]>;

const defaultKlineFetcher: KlineFetcher = (ticker) =>
  fetchBinanceKlinesDirect({
    symbol: ticker,
    timeframe: SPIKE_TIMEFRAME,
    limit: SPIKE_KLINE_LIMIT,
    market: "spot",
  }).then(dropUnclosedCandle);

let spikeCache: { at: number; hits: SpikeHit[] } | null = null;
let spikeInflight: Promise<SpikeHit[]> | null = null;

/**
 * Runs the pure detector over every candidate's short-TF klines and returns
 * the hits, heaviest volume first. Pure but for the injected fetcher.
 */
export async function scanSpikes(
  candidates: MarketOpportunity[],
  fetchKlines: KlineFetcher = defaultKlineFetcher,
): Promise<SpikeHit[]> {
  const hits = await Promise.all(
    candidates.map(async (c): Promise<SpikeHit | null> => {
      const spike = detectSpike(await fetchKlines(c.ticker));
      if (!spike) return null;
      return { ticker: c.ticker, name: c.name, price: c.price, tracked: c.tracked, spike };
    }),
  );
  return hits
    .filter((h): h is SpikeHit => h !== null)
    .sort((a, b) => b.spike.volumeMult - a.spike.volumeMult || a.ticker.localeCompare(b.ticker));
}

/**
 * Recomputes the spike cache over the current liquidity tier and returns the
 * hits. Concurrent callers (a page load and the watch timer) share one
 * in-flight run rather than double-fetching the whole tier. On the demo build
 * there are no real klines, so the cache is emptied and no fetch is made.
 */
export async function refreshSpikes(fetchKlines?: KlineFetcher): Promise<SpikeHit[]> {
  if (spikeInflight) return spikeInflight;
  spikeInflight = (async () => {
    try {
      const scan = await computeRankedScan();
      if (scan.source !== "live") {
        spikeCache = { at: Date.now(), hits: [] };
        return [];
      }
      const hits = await scanSpikes(scan.ranked, fetchKlines);
      spikeCache = { at: Date.now(), hits };
      return hits;
    } finally {
      spikeInflight = null;
    }
  })();
  return spikeInflight;
}

/** Kicks a background refresh when the cache is stale; never blocks the caller. */
function ensureFreshSpikes(): void {
  if (spikeCache && Date.now() - spikeCache.at < SPIKE_TTL_MS) return;
  if (spikeInflight) return;
  void refreshSpikes().catch(() => {});
}

async function computeScan(): Promise<OpportunityScan> {
  const scan = await computeRankedScan();
  // Read (never compute) the last spike scan, and kick a refresh if it's gone
  // stale so the next load is current — the page itself never waits on klines.
  if (scan.source === "live") ensureFreshSpikes();
  const spikes = scan.source === "live" ? (spikeCache?.hits ?? []) : [];
  const spikeByTicker = new Map(spikes.map((h) => [h.ticker, h.spike]));

  const opportunities = scan.ranked.slice(0, TOP_N).map((o) => {
    const spike = spikeByTicker.get(o.ticker);
    return spike ? { ...o, spike } : o;
  });

  return {
    source: scan.source,
    updatedAt: scan.updatedAt,
    pairsSeen: scan.pairsSeen,
    pairsRanked: scan.ranked.length,
    exchangeQuoteVolume24h: scan.exchangeQuoteVolume24h,
    opportunities,
    spikes,
  };
}

export const fetchOpportunityScanServer = createServerFn({ method: "GET" }).handler(computeScan);

/** Client-facing helper: server scan, falling back to the deterministic demo build. */
export async function fetchOpportunityScan(): Promise<OpportunityScan> {
  try {
    return await fetchOpportunityScanServer();
  } catch {
    return buildDemoScan();
  }
}
