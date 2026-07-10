/* Hypothesis H-LB (emerged from the TRX diagnosis, NOT a gated arm):
   i.mss = the first 15m CLOSE through the most recent counter-trend internal
   high, where "internal high" = a fine-tier pivot (half window) on the SAME
   exec chart. Knowable at the closing bar — no pivot-confirmation wait.
   Sanity: does this fire at the drawn i.mss level/time on trx-tp3 and zec-tp? */
import { pivotWindow } from "../../../src/lib/engine/analysis";
import { toAlternatingSwings } from "../../../src/lib/engine/structure";
import {
  labelTime,
  loadDreimannFixture,
  type DreimannTradeName,
} from "../../../src/lib/engine/__fixtures__/dreimann";
import type { Candle, PivotPoint } from "../../../src/lib/engine/types";

function pivotsWithWindow(candles: Candle[], k: number): PivotPoint[] {
  const n = candles.length;
  if (n < 2 * k + 1) return [];
  const out: PivotPoint[] = [];
  for (let i = k; i < n - k; i++) {
    let isHigh = true,
      isLow = true;
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

const iso = (s: number) => new Date(s * 1000).toISOString();

for (const name of ["trx-tp3", "zec-tp"] as DreimannTradeName[]) {
  const fixture = loadDreimannFixture(name);
  const exec = fixture.series[fixture.labels.executionTimeframe]!;
  const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
  console.log(`\n=== ${name} (entry ${fixture.labels.entry.price} @ ${iso(entryTime)})`);

  // Walk closed bars; at each bar t: fine-tier pivots on prefix, take the most
  // recent fine swing high strictly before t whose level price has NOT yet
  // closed above since it printed; fire when bar t CLOSES above it.
  const fired: Array<{ at: number; level: number; levelTime: number }> = [];
  for (let t = 80; t < exec.length && exec[t].time <= entryTime; t++) {
    const prefix = exec.slice(0, t + 1);
    const kFine = Math.max(2, Math.floor(pivotWindow(prefix.length) / 2));
    const fine = toAlternatingSwings(pivotsWithWindow(prefix, kFine));
    // most recent fine high before this bar
    const highs = fine.filter((p) => p.kind === "high" && p.time < exec[t].time);
    const lastHigh = highs[highs.length - 1];
    if (!lastHigh) continue;
    // fire on first close through it (and dedupe by level+time)
    if (exec[t].close > lastHigh.price) {
      const key = `${lastHigh.time}`;
      if (!fired.some((f) => `${f.levelTime}` === key)) {
        fired.push({ at: exec[t].time, level: lastHigh.price, levelTime: lastHigh.time });
      }
    }
  }
  console.log(`  close-through-internal-high events before entry (last 8):`);
  for (const f of fired.slice(-8)) {
    console.log(
      `    ${iso(f.at)} closed above fine high ${f.level} (drawn from ${iso(f.levelTime)})`,
    );
  }
}
