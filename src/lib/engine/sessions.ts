import { createServerFn } from "@tanstack/react-start";

import { dropUnclosedCandle, fetchBinanceKlinesDirect, type MarketType } from "./binance";
import type { Candle } from "./types";

/**
 * Trading-session high/low levels. Crypto trades 24/7, but liquidity and
 * character still rotate through the Asia, European and US sessions, and the
 * high/low a session prints become the intraday levels traders lean on the next
 * day ("holding the Asia low", "reclaiming the London high"). This computes the
 * most recent *completed* session's range for each region so they can be drawn
 * as levels and fed to location grading as structure.
 *
 * Windows are UTC and non-overlapping so each session prints one clean H/L.
 * Best computed from 1H candles — each bar summarizes an hour of the session.
 */

export type TradingSession = "asia" | "eu" | "us";

interface SessionWindow {
  session: TradingSession;
  label: string;
  /** UTC hours [start, end). */
  startHour: number;
  endHour: number;
}

// Non-overlapping UTC blocks. Tokyo runs the early hours, London the middle, New
// York the afternoon; 21:00–24:00 is the thin post-US lull and is left out so it
// doesn't smear into the next Asia range.
export const SESSION_WINDOWS: readonly SessionWindow[] = [
  { session: "asia", label: "Asia", startHour: 0, endHour: 8 },
  { session: "eu", label: "London", startHour: 8, endHour: 13 },
  { session: "us", label: "New York", startHour: 13, endHour: 21 },
];

export interface SessionLevel {
  session: TradingSession;
  label: string;
  high: number;
  low: number;
  /** UTC ms of the session window's start and end. */
  startMs: number;
  endMs: number;
}

function windowFor(hour: number): SessionWindow | null {
  return SESSION_WINDOWS.find((w) => hour >= w.startHour && hour < w.endHour) ?? null;
}

/**
 * Most recent completed session per region, from the candle set. A session is
 * "completed" once its window end is in the past (`nowMs`); the still-forming
 * current session is skipped so its H/L doesn't move under you.
 */
export function computeSessionLevels(
  candles: Candle[],
  nowMs: number = Date.now(),
): SessionLevel[] {
  if (candles.length === 0) return [];

  // Accumulate H/L per concrete session instance, keyed by its UTC start ms.
  const instances = new Map<
    string,
    {
      session: TradingSession;
      label: string;
      high: number;
      low: number;
      startMs: number;
      endMs: number;
    }
  >();

  for (const c of candles) {
    const ms = c.time * 1000;
    const d = new Date(ms);
    const win = windowFor(d.getUTCHours());
    if (!win) continue;
    const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), win.startHour);
    const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), win.endHour);
    if (endMs > nowMs) continue; // session not finished yet

    const key = `${win.session}-${startMs}`;
    const existing = instances.get(key);
    if (existing) {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
    } else {
      instances.set(key, {
        session: win.session,
        label: win.label,
        high: c.high,
        low: c.low,
        startMs,
        endMs,
      });
    }
  }

  // Pick the latest completed instance for each region.
  const latest = new Map<TradingSession, SessionLevel>();
  for (const inst of instances.values()) {
    const held = latest.get(inst.session);
    if (!held || inst.startMs > held.startMs) latest.set(inst.session, { ...inst });
  }

  return SESSION_WINDOWS.map((w) => latest.get(w.session)).filter(
    (l): l is SessionLevel => l !== undefined,
  );
}

const SESSION_LEVELS_CANDLE_LIMIT = 168; // a week of 1H candles

/**
 * Fetch a week of 1H candles and compute session levels — the one path both
 * the server worker and the token-page UI (via `fetchSessionLevelsServer`
 * below) run, so a shadow/anticipatory record's session levels are provably
 * the same input the UI would have shown for the same symbol.
 */
export async function fetchSessionLevels(
  symbol: string,
  market: MarketType,
): Promise<SessionLevel[]> {
  const candles = await fetchBinanceKlinesDirect({
    symbol,
    timeframe: "1H",
    limit: SESSION_LEVELS_CANDLE_LIMIT,
    market,
  });
  return candles.length > 0 ? computeSessionLevels(dropUnclosedCandle(candles)) : [];
}

export const fetchSessionLevelsServer = createServerFn({ method: "GET" })
  .validator((data: { symbol: string; market?: MarketType }) => ({
    symbol: typeof data?.symbol === "string" ? data.symbol : "",
    market: (data?.market === "perp" ? "perp" : "spot") as MarketType,
  }))
  .handler(async ({ data }) => fetchSessionLevels(data.symbol, data.market));

/** One horizontal price a session prints — its high or its low. */
export interface SessionPrice {
  label: string;
  session: TradingSession;
  kind: "high" | "low";
  price: number;
}

/** Flatten session levels into individual high/low prices for level-matching. */
export function sessionPrices(levels: SessionLevel[]): SessionPrice[] {
  return levels.flatMap((l) => [
    { label: l.label, session: l.session, kind: "high" as const, price: l.high },
    { label: l.label, session: l.session, kind: "low" as const, price: l.low },
  ]);
}

/**
 * The nearest session level acting as structure on the entry side for a
 * direction: a level at or below price for a long (support it's holding), at or
 * above for a short (resistance it's capped by), within `maxDistance`.
 */
export function nearestSessionStructure(
  levels: SessionLevel[],
  direction: "long" | "short",
  price: number,
  maxDistance: number,
): SessionPrice | null {
  const onSide = sessionPrices(levels).filter((p) =>
    direction === "long" ? p.price <= price : p.price >= price,
  );
  let best: SessionPrice | null = null;
  let bestDist = Infinity;
  for (const p of onSide) {
    const dist = Math.abs(price - p.price);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best && bestDist <= maxDistance ? best : null;
}
