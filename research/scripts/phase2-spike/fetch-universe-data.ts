/**
 * Data capture for the G1 tier spike (research/analysis.md §10): the
 * 18-asset universe on every timeframe the comparison touches — execution
 * TFs 15m/1h/4h plus their intent-paired context TFs 1h/4h/1d — 1000 closed
 * bars each from Binance spot (the universe's venue).
 *
 *   bun run research/scripts/phase2-spike/fetch-universe-data.ts <outDir>
 *
 * The capture is a spike input, not a fixture: it is cached outside the repo
 * (pass the cache dir; the spike report records the exact window) and the
 * spike runner reads it from there. Re-running refreshes the window.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { UNIVERSE } from "../../../src/lib/engine/market";

const INTERVALS = ["15m", "1h", "4h", "1d"] as const;
const LIMIT = 1000;

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: bun fetch-universe-data.ts <outDir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

interface RawKline extends Array<unknown> {
  0: number; // open time ms
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
  6: number; // close time ms
}

async function fetchKlines(symbol: string, interval: string) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${symbol} ${interval}: HTTP ${res.status}`);
  const raw = (await res.json()) as RawKline[];
  // Drop the still-forming final bar — the spike is closed-bar only.
  const closed = raw.filter((k) => k[6] < Date.now());
  return closed.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

const meta: Record<string, { first: string; last: string; bars: number }> = {};
for (const entry of UNIVERSE) {
  const symbol = `${entry.ticker}USDT`;
  for (const interval of INTERVALS) {
    const candles = await fetchKlines(symbol, interval);
    writeFileSync(join(outDir, `${symbol}-${interval}.json`), JSON.stringify(candles));
    meta[`${symbol}-${interval}`] = {
      first: new Date(candles[0].time * 1000).toISOString(),
      last: new Date(candles[candles.length - 1].time * 1000).toISOString(),
      bars: candles.length,
    };
    console.log(`${symbol} ${interval}: ${candles.length} bars`);
    await new Promise((r) => setTimeout(r, 120)); // stay far under rate limits
  }
}
writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
console.log(`\ncached ${Object.keys(meta).length} series to ${outDir}`);
