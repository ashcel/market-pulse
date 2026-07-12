/**
 * Phase 3 spike — fixture sanity (research/phase3-spike.md: "the 7 Dreimann
 * trades are walked as-of-bar to confirm both triggers produce non-garbage
 * structure and that H-LB fires at the annotated i.mss level/time — but the
 * verdict comes from the gates, not the fixtures"). NEVER the scoring set —
 * `run-spike.ts`'s gates are.
 *
 *   bun run research/scripts/phase3-spike/fixture-sanity.ts
 *
 * Only six Dreimann trades are committed in `__fixtures__/dreimann`
 * (`DREIMANN_TRADES`), not seven — the "7" in phase0/phase3 docs is a stale
 * count from an earlier fixture set. This walks every fixture that exists;
 * that discrepancy is flagged in the output rather than papered over.
 *
 * For each fixture, walks the execution chart as-of-bar (bar-limited
 * prefixes, no lookahead) and reports every H-LB fire — a closed-bar close
 * through the leg-scoped fine-tier anchor (leg-scope.ts, the same frozen
 * module run-spike.ts uses) — in the window before the labeled entry. The
 * incumbent CHoCH's bullish/bearish shifts are printed alongside for
 * comparison, exactly as phase2's imss-sanity.ts did for its two arms.
 *
 * trx-tp3 is the one fixture with a numeric i.mss annotation transcribed
 * into labels.json's free-text notes ("~0.3296 on Jul 8") — that fixture
 * gets an explicit tolerance-checked MATCH/NO-MATCH report. The rest have no
 * structured level to assert against automatically, so their output is for
 * eyeball comparison against the source chart, same as phase2.
 *
 * A NO-MATCH is reported, never asserted as a script failure (exit code
 * stays 0): per the protocol, "fixture sanity is never the scoring set,"
 * and tuning the leg-scoped anchor rule until this one fixture matches would
 * be exactly the p-hacking the pre-registration discipline forbids. See the
 * trx-tp3 finding recorded in phase3-spike.md once the spike is run.
 */

import { computePivots, pivotWindow } from "../../../src/lib/engine/analysis";
import { computeMarketStructure, type MarketStructure } from "../../../src/lib/engine/structure";
import {
  DREIMANN_TRADES,
  labelTime,
  loadDreimannFixture,
  type DreimannTradeName,
} from "../../../src/lib/engine/__fixtures__/dreimann";
import type { Candle } from "../../../src/lib/engine/types";
import { findLegOrigin, originKey, pivotsWithWindow } from "./leg-scope";

const iso = (sec: number) => new Date(sec * 1000).toISOString();

/** First bar index evaluated — mirrors run-spike's lead-in, scaled down for shorter fixture series. */
const LEAD_IN_BARS = 60;
const PRE_ENTRY_WINDOW_HOURS = 48;

interface HlbFire {
  at: number;
  level: number;
  levelTime: number;
}

function walkHlbFires(exec: Candle[], bias: "long" | "short", upToTime: number): HlbFire[] {
  const fires: HlbFire[] = [];
  let prevKey: string | null = null;
  for (let t = LEAD_IN_BARS; t < exec.length && exec[t].time <= upToTime; t++) {
    const prefix = exec.slice(0, t + 1);
    const kFine = Math.max(2, Math.floor(pivotWindow(prefix.length) / 2));
    const fine = computeMarketStructure(pivotsWithWindow(prefix, kFine));
    const origin = findLegOrigin(fine.swings, bias);
    if (!origin) {
      prevKey = null;
      continue;
    }
    const close = exec[t].close;
    const fired = bias === "long" ? close > origin.price : close < origin.price;
    if (!fired) continue;
    const key = originKey(origin);
    if (key === prevKey) continue;
    prevKey = key;
    fires.push({ at: exec[t].time, level: origin.price, levelTime: origin.time });
  }
  return fires;
}

interface ChochShift {
  knowableAt: number;
  brokenLevel: number;
  eventSwing: number;
}

function walkChochShifts(exec: Candle[], bias: "long" | "short", upToTime: number): ChochShift[] {
  const shifts: ChochShift[] = [];
  let prevKey: string | null = null;
  const wantLabel = bias === "long" ? "HH" : "LL";
  const priorKind = bias === "long" ? "high" : "low";
  for (let t = LEAD_IN_BARS; t < exec.length && exec[t].time <= upToTime; t++) {
    const prefix = exec.slice(0, t + 1);
    const structure: MarketStructure = computeMarketStructure(computePivots(prefix));
    const event = structure.eventSwing;
    const key = event ? `${event.time}:${event.kind}:${structure.event}` : null;
    const isNew = key !== null && key !== prevKey;
    prevKey = key;
    if (!isNew || structure.event !== "choch" || event!.label !== wantLabel) continue;
    const prior = [...structure.swings]
      .reverse()
      .find((s) => s.kind === priorKind && s.time < event!.time);
    if (!prior) continue;
    shifts.push({ knowableAt: exec[t].time, brokenLevel: prior.price, eventSwing: event!.price });
  }
  return shifts;
}

const TRX_IMSS_LEVEL = 0.3296;
const TRX_IMSS_TOLERANCE_PCT = 1.0;

console.log(
  `Dreimann fixtures available: ${DREIMANN_TRADES.length} (${DREIMANN_TRADES.join(", ")}) — phase0/phase3 docs say "7"; only ${DREIMANN_TRADES.length} are committed.\n`,
);

for (const name of DREIMANN_TRADES as readonly DreimannTradeName[]) {
  const fixture = loadDreimannFixture(name);
  const exec = fixture.series[fixture.labels.executionTimeframe];
  if (!exec) {
    console.log(
      `=== ${name}: no series for executionTimeframe ${fixture.labels.executionTimeframe} — skipping`,
    );
    continue;
  }
  const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
  const windowStart = entryTime - PRE_ENTRY_WINDOW_HOURS * 3600;
  const bias = fixture.labels.direction;

  console.log(
    `=== ${name} (${fixture.labels.symbol}, ${fixture.labels.executionTimeframe}, ${bias}, entry ${fixture.labels.entry.price} @ ${iso(entryTime)})`,
  );

  const hlbFires = walkHlbFires(exec, bias, entryTime).filter((f) => f.at >= windowStart);
  console.log(`  H-LB fires in the ${PRE_ENTRY_WINDOW_HOURS}h before entry:`);
  if (hlbFires.length === 0) console.log("    (none)");
  for (const f of hlbFires) {
    console.log(`    ${iso(f.at)} closed through ${f.level} (anchor from ${iso(f.levelTime)})`);
  }

  const chochShifts = walkChochShifts(exec, bias, entryTime).filter(
    (s) => s.knowableAt >= windowStart,
  );
  console.log(`  CHoCH (incumbent) shifts in the ${PRE_ENTRY_WINDOW_HOURS}h before entry:`);
  if (chochShifts.length === 0) console.log("    (none)");
  for (const s of chochShifts) {
    console.log(
      `    knowable ${iso(s.knowableAt)} — broke level ${s.brokenLevel} (event swing ${s.eventSwing})`,
    );
  }

  if (name === "trx-tp3") {
    const tolerance = TRX_IMSS_LEVEL * (TRX_IMSS_TOLERANCE_PCT / 100);
    const match = hlbFires.find((f) => Math.abs(f.level - TRX_IMSS_LEVEL) <= tolerance);
    console.log(
      `  i.mss annotation check: expect a fire near ${TRX_IMSS_LEVEL} (±${TRX_IMSS_TOLERANCE_PCT}%) — ${
        match ? `MATCH (${match.level} @ ${iso(match.at)})` : "NO MATCH"
      }`,
    );
  }

  console.log("");
}
