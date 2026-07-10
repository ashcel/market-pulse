import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Candle } from "../../types";

/**
 * Test-only loader for the frozen Dreimann ground-truth fixtures (see
 * README.md in this directory). Reads the committed JSON from disk — never
 * imported by app code, so nothing here reaches the client bundle.
 */

export const DREIMANN_TRADES = [
  "zec-tp",
  "trx-tp3",
  "zec-sl",
  "ethfi-sl",
  "jup-tp",
  "fet-tp",
] as const;

export type DreimannTradeName = (typeof DREIMANN_TRADES)[number];

export interface DreimannEntryLabel {
  type: "market" | "limit";
  price: number;
  /** Pinned to the first fixture bar consistent with the chart — treat as ±a few bars. */
  approxTimeUtc: string;
  source: string;
}

export interface DreimannObjectiveLabel {
  price: number;
  /** "weak-high" objectives are assertable from the window; "beyond-window" ones are not. */
  kind: "weak-high" | "beyond-window";
  withinWindow: boolean;
  /** Price tolerance (percent) when matching the objective to a derived swing. */
  tolerancePct: number;
  source: string;
}

export interface DreimannLabels {
  chart: string;
  tradingview: string;
  symbol: string;
  executionTimeframe: "15m" | "1h" | "4h";
  contextTimeframe: "4h";
  direction: "long" | "short";
  playbook: string[];
  outcome: "tp" | "tp-partial" | "sl";
  entry: DreimannEntryLabel;
  stop: { price: number; source: string };
  objective: DreimannObjectiveLabel;
  notes: string;
}

export interface DreimannFixture {
  meta: {
    symbol: string;
    chart: string;
    source: string;
    capturedAtUtc: string;
    windows: { interval: string; startUtc: string; endUtc: string }[];
  };
  series: Partial<Record<"15m" | "1h" | "4h", Candle[]>>;
  labels: DreimannLabels;
}

const fixtureDir = dirname(fileURLToPath(import.meta.url));

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as T;
}

export function loadDreimannFixture(name: DreimannTradeName): DreimannFixture {
  const data = readJson<Omit<DreimannFixture, "labels">>(`${name}.json`);
  const labels = readJson<Record<string, DreimannLabels>>("labels.json")[name];
  if (!labels) throw new Error(`labels.json has no entry for "${name}"`);
  return { ...data, labels };
}

/** Unix seconds for an ISO label timestamp, matching Candle.time. */
export function labelTime(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}
