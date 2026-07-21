import { createServerFn } from "@tanstack/react-start";

import { buildFundingScan, type FundingRow, type FundingScan } from "./funding-play";
import { binanceLimiter, PREMIUM_INDEX_ALL_WEIGHT } from "./rate-limit";
import { futuresBaseToTicker } from "./symbol-map";

/**
 * Full-exchange funding-play data plane — "what is every USDT-margined perp's
 * current funding state, right now?" Feeds `funding-play.ts`'s
 * `buildFundingScan`, which is frozen/owned elsewhere; this module only
 * fetches + normalizes the raw exchange rows into `FundingRow[]`.
 *
 * Two calls, one join:
 * - `/fapi/v1/premiumIndex` with no `symbol` param → every perp's mark/index
 *   price + last funding rate + next funding time (weight 10).
 * - `/fapi/v1/fundingInfo` → only pairs whose funding interval deviates from
 *   the 8h default (weight 1); absent pairs default to 8h.
 *
 * Like discovery.ts this is a discovery/advisor layer outside the trading
 * engine: nothing here touches decision or trigger semantics, ENGINE_VERSION,
 * or any forward-test record.
 */

const FAPI_BASE = "https://fapi.binance.com";
const DEFAULT_INTERVAL_HOURS = 8;

/** GET /fapi/v1/fundingInfo weight — small, adjusted-interval pairs only. */
const FUNDING_INFO_WEIGHT = 1;

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes the raw `/fundingInfo` array to a symbol -> intervalHours map.
 * Pairs absent from this map (the overwhelming majority) use the 8h default.
 */
export function parseFundingIntervals(payload: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!Array.isArray(payload)) return map;
  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const symbol = typeof r.symbol === "string" ? r.symbol : "";
    if (!symbol) continue;
    const hours = toFiniteNumber(r.fundingIntervalHours);
    if (hours === null) continue;
    map.set(symbol, hours);
  }
  return map;
}

/**
 * Pure mapping: raw `/premiumIndex` array + the funding-interval lookup ->
 * `FundingRow[]`. Keeps only live USDT-margined perpetuals — symbol ends in
 * "USDT" with no "_" delivery/quarterly suffix (e.g. skips "BTCUSDT_250926")
 * and no non-USDT quote (e.g. "BTCUSDC") — and drops any row with a
 * malformed/NaN numeric field rather than passing a broken row through.
 */
export function mapFundingRows(
  premiumIndexPayload: unknown,
  intervalHoursBySymbol: Map<string, number>,
): FundingRow[] {
  if (!Array.isArray(premiumIndexPayload)) return [];
  const rows: FundingRow[] = [];
  for (const raw of premiumIndexPayload) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const symbol = typeof r.symbol === "string" ? r.symbol : "";
    if (!symbol || symbol.includes("_") || !symbol.endsWith("USDT")) continue;
    const ticker = futuresBaseToTicker(symbol.slice(0, -4));
    if (!ticker) continue;

    const fundingRate = toFiniteNumber(r.lastFundingRate);
    const markPrice = toFiniteNumber(r.markPrice);
    const indexPrice = toFiniteNumber(r.indexPrice);
    const nextFundingMs = toFiniteNumber(r.nextFundingTime);
    if (
      fundingRate === null ||
      markPrice === null ||
      indexPrice === null ||
      nextFundingMs === null ||
      markPrice <= 0
    ) {
      continue;
    }

    rows.push({
      ticker,
      pair: symbol,
      fundingRate,
      nextFundingMs,
      markPrice,
      indexPrice,
      intervalHours: intervalHoursBySymbol.get(symbol) ?? DEFAULT_INTERVAL_HOURS,
    });
  }
  return rows;
}

/**
 * Deterministic offline fallback — a small hand-picked set spanning neutral,
 * extreme-longs-crowded, extreme-shorts-crowded, and an adjusted (non-8h)
 * interval pair, staggered across the entry window so the demo surface
 * exercises every `FundingPlayPhase` without needing live exchange data.
 */
function buildDemoRows(nowMs: number): FundingRow[] {
  const seeds: Array<{
    ticker: string;
    fundingRate: number;
    markPrice: number;
    intervalHours?: number;
    minutesToFunding: number;
  }> = [
    { ticker: "BTC", fundingRate: 0.0001, markPrice: 65_000, minutesToFunding: 240 },
    { ticker: "ETH", fundingRate: -0.00015, markPrice: 3_200, minutesToFunding: 180 },
    { ticker: "SOL", fundingRate: 0.0062, markPrice: 150, minutesToFunding: 12 },
    { ticker: "DOGE", fundingRate: -0.0075, markPrice: 0.12, minutesToFunding: 45 },
    {
      ticker: "PEPE",
      fundingRate: 0.021,
      markPrice: 0.000012,
      intervalHours: 4,
      minutesToFunding: 5,
    },
  ];
  return seeds.map(
    (seed): FundingRow => ({
      ticker: seed.ticker,
      pair: `${seed.ticker}USDT`,
      fundingRate: seed.fundingRate,
      markPrice: seed.markPrice,
      indexPrice: seed.markPrice * 0.9995,
      nextFundingMs: nowMs + seed.minutesToFunding * 60_000,
      intervalHours: seed.intervalHours ?? DEFAULT_INTERVAL_HOURS,
    }),
  );
}

export function buildDemoFundingScan(nowMs: number = Date.now()): FundingScan {
  return buildFundingScan(buildDemoRows(nowMs), nowMs, "demo");
}

async function fetchPremiumIndexAll(): Promise<unknown> {
  await binanceLimiter.acquire(PREMIUM_INDEX_ALL_WEIGHT);
  const response = await fetch(`${FAPI_BASE}/fapi/v1/premiumIndex`);
  if (!response.ok) return null;
  return response.json();
}

async function fetchFundingInfoAll(): Promise<unknown> {
  await binanceLimiter.acquire(FUNDING_INFO_WEIGHT);
  const response = await fetch(`${FAPI_BASE}/fapi/v1/fundingInfo`);
  if (!response.ok) return null;
  return response.json();
}

/** Cached ~20s server-side — funding rates only settle every few hours, but
 * the entry-window/phase math is minute-scale, so a short TTL keeps repeated
 * page loads cheap without staling the "is it time to enter" verdict. */
let scanCache: { at: number; data: FundingScan } | null = null;
const SCAN_TTL_MS = 20_000;

async function computeFundingScan(): Promise<FundingScan> {
  const now = Date.now();
  if (scanCache && now - scanCache.at < SCAN_TTL_MS) return scanCache.data;

  try {
    const [premiumPayload, intervalPayload] = await Promise.all([
      fetchPremiumIndexAll(),
      fetchFundingInfoAll(),
    ]);
    if (!premiumPayload) return buildDemoFundingScan(now);

    const intervalMap = parseFundingIntervals(intervalPayload);
    const rows = mapFundingRows(premiumPayload, intervalMap);
    // A near-empty parse means Binance was unreachable or degraded, not that
    // there are genuinely few perps — fall back to demo rather than an
    // empty scan (mirrors discovery.ts's computeRankedScan).
    if (rows.length < 30) return buildDemoFundingScan(now);

    const data = buildFundingScan(rows, now, "live");
    scanCache = { at: now, data };
    return data;
  } catch {
    return buildDemoFundingScan(now);
  }
}

export const fetchFundingScanServer = createServerFn({ method: "GET" }).handler(computeFundingScan);

/** Client-facing helper: server scan, falling back to the deterministic demo build. */
export async function fetchFundingScan(): Promise<FundingScan> {
  try {
    return await fetchFundingScanServer();
  } catch {
    return buildDemoFundingScan();
  }
}
