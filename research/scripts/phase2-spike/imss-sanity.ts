/**
 * G1 spike sanity check (research/analysis.md §10: "the 7 charts are a sanity
 * check that both models produce non-garbage structure — never the scoring
 * set"). Question: walking the execution chart as-of each bar, does the
 * cross-TF internal tier (the exec chart's own structure) print an aligned
 * CHoCH whose broken level and timing match the i.mss annotation Dreimann
 * drew? trx-tp3 pins the annotation numerically (~0.3296 on Jul 8, from
 * labels.json notes); zec-tp has an i.mss label read qualitatively off the
 * chart. The nested arm's context fine tier is printed alongside for
 * comparison.
 *
 *   bun run research/scripts/phase2-spike/imss-sanity.ts
 */

import { computePivots, pivotWindow } from "../../../src/lib/engine/analysis";
import {
  computeMarketStructure,
  structureLean,
  type MarketStructure,
} from "../../../src/lib/engine/structure";
import type { Candle, PivotPoint } from "../../../src/lib/engine/types";
import {
  labelTime,
  loadDreimannFixture,
  type DreimannTradeName,
} from "../../../src/lib/engine/__fixtures__/dreimann";

function pivotsWithWindow(candles: Candle[], k: number): PivotPoint[] {
  const n = candles.length;
  if (n < 2 * k + 1) return [];
  const out: PivotPoint[] = [];
  for (let i = k; i < n - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high || (candles[j].high === candles[i].high && j < i))
        isHigh = false;
      if (candles[j].low < candles[i].low || (candles[j].low === candles[i].low && j < i))
        isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isLow) out.push({ time: candles[i].time, price: candles[i].low, kind: "low" });
    if (isHigh) out.push({ time: candles[i].time, price: candles[i].high, kind: "high" });
  }
  return out;
}

/**
 * Walk prefixes of `candles`; report every bar where the structure's latest
 * event becomes a NEW bullish CHoCH (label HH), with the level whose break
 * produced it — the prior swing high, which is where the i.mss line is drawn.
 */
function bullishShifts(
  candles: Candle[],
  structureOf: (prefix: Candle[]) => MarketStructure,
  fromTime: number,
  toTime: number,
): Array<{ knowableAt: number; brokenLevel: number; eventSwing: number }> {
  const shifts: Array<{ knowableAt: number; brokenLevel: number; eventSwing: number }> = [];
  let prevKey: string | null = null;
  for (let t = 60; t < candles.length; t++) {
    if (candles[t].time > toTime) break;
    const structure = structureOf(candles.slice(0, t + 1));
    const event = structure.eventSwing;
    const key = event ? `${event.time}:${event.kind}:${structure.event}` : null;
    const isNew = key !== null && key !== prevKey;
    prevKey = key;
    if (!isNew || structure.event !== "choch" || event!.label !== "HH") continue;
    if (candles[t].time < fromTime) continue;
    // The broken level: the most recent prior swing high before the event swing.
    const prior = [...structure.swings]
      .reverse()
      .find((s) => s.kind === "high" && s.time < event!.time);
    if (!prior) continue;
    shifts.push({
      knowableAt: candles[t].time,
      brokenLevel: prior.price,
      eventSwing: event!.price,
    });
  }
  return shifts;
}

const iso = (sec: number) => new Date(sec * 1000).toISOString();

for (const name of ["trx-tp3", "zec-tp"] as DreimannTradeName[]) {
  const fixture = loadDreimannFixture(name);
  const exec = fixture.series[fixture.labels.executionTimeframe]!;
  const ctx = fixture.series["4h"]!;
  const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
  const dayBefore = entryTime - 36 * 3600;

  console.log(`\n=== ${name} (entry ${fixture.labels.entry.price} @ ${iso(entryTime)})`);

  // Context bias as-of entry (the shared swing tier).
  const ctxAtEntry = computeMarketStructure(computePivots(ctx.filter((c) => c.time <= entryTime)));
  console.log(`  4h swing-tier lean as-of entry: ${structureLean(ctxAtEntry)}`);

  // CROSS-TF internal: the exec chart's own structure.
  const crossShifts = bullishShifts(
    exec,
    (prefix) => computeMarketStructure(computePivots(prefix)),
    dayBefore,
    entryTime,
  );
  console.log(`  cross-TF internal bullish CHoCHs in the 36h before entry:`);
  for (const s of crossShifts) {
    console.log(
      `    knowable ${iso(s.knowableAt)} — broke internal high ${s.brokenLevel} (event swing ${s.eventSwing})`,
    );
  }
  if (crossShifts.length === 0) console.log("    (none)");

  // NESTED internal: fine pivots (half window) on the 4h context chart.
  const nestedShifts = bullishShifts(
    ctx,
    (prefix) => {
      const k = Math.max(2, Math.floor(pivotWindow(prefix.length) / 2));
      return computeMarketStructure(pivotsWithWindow(prefix, k));
    },
    dayBefore - 24 * 3600,
    entryTime,
  );
  console.log(`  nested (4h fine-tier) bullish CHoCHs in the 60h before entry:`);
  for (const s of nestedShifts) {
    console.log(
      `    knowable ${iso(s.knowableAt)} — broke internal high ${s.brokenLevel} (event swing ${s.eventSwing})`,
    );
  }
  if (nestedShifts.length === 0) console.log("    (none)");
}
