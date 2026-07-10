/**
 * One-off fixture capture for the Dreimann ground-truth charts
 * (research/dreimann/*.png + trades.txt). Fetches Binance USDT-M perpetual
 * klines — the venue the charts were drawn on — for each trade's execution
 * and context timeframes, and freezes them under
 * src/lib/engine/__fixtures__/dreimann/. Tests never fetch; they read the
 * committed JSON. Re-running this script overwrites the fixtures, so only do
 * that deliberately (the hand labels in labels.json are aligned to this data).
 *
 *   bun run research/scripts/fetch-dreimann-fixtures.ts
 *
 * HYPE is deliberately absent: its chart is a MEXC perp (different venue's
 * prices) and trades.txt records no absolute entry/stop/target for it, so
 * there would be nothing to validate against. See the fixture README.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface FixtureCandle {
  time: number; // bar open, unix seconds (matches the engine's Candle.time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SeriesSpec {
  interval: "15m" | "1h" | "4h";
  /** ISO-8601 UTC window; inclusive start, exclusive end. */
  startUtc: string;
  endUtc: string;
}

interface TradeSpec {
  /** Fixture file basename, matching the key in labels.json. */
  name: string;
  symbol: string;
  chart: string;
  series: SeriesSpec[];
}

/**
 * Windows cover each chart's visible range plus enough left margin for pivots
 * and structure to form (the engine needs ~50+ bars) and enough right margin
 * for the trade's outcome to resolve. Every window stays under Binance's
 * 1000-bar-per-request cap so one request per series suffices.
 */
const CAPTURED_AT_UTC = "2026-07-10T00:00:00Z";

const TRADES: TradeSpec[] = [
  {
    name: "zec-tp",
    symbol: "ZECUSDT",
    chart: "zec_hit_tp.png",
    series: [
      { interval: "15m", startUtc: "2026-07-05T00:00:00Z", endUtc: CAPTURED_AT_UTC },
      { interval: "4h", startUtc: "2026-06-20T00:00:00Z", endUtc: CAPTURED_AT_UTC },
    ],
  },
  {
    name: "trx-tp3",
    symbol: "TRXUSDT",
    chart: "trx_hit_tp_max.png",
    series: [
      { interval: "15m", startUtc: "2026-07-05T00:00:00Z", endUtc: CAPTURED_AT_UTC },
      { interval: "4h", startUtc: "2026-06-20T00:00:00Z", endUtc: CAPTURED_AT_UTC },
    ],
  },
  {
    name: "zec-sl",
    symbol: "ZECUSDT",
    chart: "zec_hit_sl.png",
    series: [
      { interval: "15m", startUtc: "2026-07-04T00:00:00Z", endUtc: "2026-07-09T00:00:00Z" },
      { interval: "4h", startUtc: "2026-06-15T00:00:00Z", endUtc: "2026-07-09T00:00:00Z" },
    ],
  },
  {
    name: "ethfi-sl",
    symbol: "ETHFIUSDT",
    chart: "ethfi_hit_sl.png",
    series: [
      { interval: "1h", startUtc: "2026-06-28T00:00:00Z", endUtc: CAPTURED_AT_UTC },
      { interval: "4h", startUtc: "2026-06-15T00:00:00Z", endUtc: CAPTURED_AT_UTC },
    ],
  },
  {
    name: "jup-tp",
    symbol: "JUPUSDT",
    chart: "jup_hit_tp.png",
    series: [
      { interval: "1h", startUtc: "2026-06-25T00:00:00Z", endUtc: "2026-07-08T00:00:00Z" },
      { interval: "4h", startUtc: "2026-06-15T00:00:00Z", endUtc: "2026-07-08T00:00:00Z" },
    ],
  },
  {
    name: "fet-tp",
    symbol: "FETUSDT",
    chart: "fet_hit_tp_max.png",
    series: [
      { interval: "15m", startUtc: "2026-06-28T00:00:00Z", endUtc: "2026-07-04T00:00:00Z" },
      { interval: "4h", startUtc: "2026-06-15T00:00:00Z", endUtc: "2026-07-04T00:00:00Z" },
    ],
  },
];

async function fetchSeries(symbol: string, spec: SeriesSpec): Promise<FixtureCandle[]> {
  const params = new URLSearchParams({
    symbol,
    interval: spec.interval,
    startTime: String(Date.parse(spec.startUtc)),
    endTime: String(Date.parse(spec.endUtc) - 1),
    limit: "1000",
  });
  const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`);
  if (!response.ok) {
    throw new Error(`${symbol} ${spec.interval}: HTTP ${response.status} ${await response.text()}`);
  }
  const rows = (await response.json()) as [number, string, string, string, string, string][];
  if (rows.length >= 1000) {
    throw new Error(`${symbol} ${spec.interval}: window hit the 1000-bar cap; shrink it`);
  }
  return rows.map(([openTime, open, high, low, close, volume]) => ({
    time: Math.floor(Number(openTime) / 1000),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }));
}

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/engine/__fixtures__/dreimann",
);
mkdirSync(outDir, { recursive: true });

for (const trade of TRADES) {
  const series: Record<string, FixtureCandle[]> = {};
  for (const spec of trade.series) {
    series[spec.interval] = await fetchSeries(trade.symbol, spec);
    console.log(`${trade.name} ${spec.interval}: ${series[spec.interval].length} candles`);
  }
  const fixture = {
    meta: {
      symbol: trade.symbol,
      chart: trade.chart,
      source: "binance-usdm-perp",
      capturedAtUtc: CAPTURED_AT_UTC,
      windows: trade.series,
    },
    series,
  };
  writeFileSync(join(outDir, `${trade.name}.json`), JSON.stringify(fixture));
}
console.log(`Wrote ${TRADES.length} fixtures to ${outDir}`);
