/**
 * G1 tier spike — the pre-registered comparison from research/analysis.md §10.
 *
 *   bun run research/scripts/phase2-spike/run-spike.ts <dataDir>
 *
 * Question: does NESTED single-chart two-tier structure (challenger: internal
 * tier = finer pivots on the context chart) produce materially better
 * confirmation-mode decisions than the CROSS-TF incumbent (internal tier =
 * the execution TF's own structure)? Cross-TF wins ties, wins on
 * insufficient sample, wins when the effect is immaterial.
 *
 * ## Frozen, shared by both arms (isolation — one variable only)
 * - Swing tier & bias: the context TF's structure lean (structureLean), as-of
 *   the execution bar, from bar-limited context prefixes.
 * - Objective: resolveObjectives over the context structure + pools, at the
 *   trigger bar's close; the preferred candidate. Empty → no decision.
 * - Trigger RULE: the internal tier's latest structural event, as-of the
 *   execution bar, is a NEW CHoCH in the bias direction (new = its event
 *   swing differs from the previous execution bar's read). i.mss, formalized.
 * - Entry model: market at the trigger bar's close (confirmation mode).
 * - Stop RULE: the internal tier's most recent opposite-kind swing before the
 *   trigger (the shift's origin). The rule is frozen; its value flows from
 *   each arm's own internal tier — exactly what the tier is FOR.
 * - Outcome walk: execution bars after the trigger bar, stop checked before
 *   objective within a bar (walkExitLevels convention); horizon K =
 *   INTENT_MAX_HOLD_BARS of the execution TF's intent (16/24/42). Unresolved
 *   at K = censored, scored at mark-to-horizon R (never silently dropped).
 *
 * ## The one swapped component
 * - CROSS-TF internal: computeMarketStructure(computePivots(exec prefix)).
 * - NESTED internal: computeMarketStructure(pivots at HALF the swing pivot
 *   window on the CONTEXT prefix) — one octave down, the same chart as the
 *   swing tier. k_int = max(2, floor(pivotWindow(n)/2)); the octave step is a
 *   structural choice fixed before running, not a tuned constant.
 *
 * ## Pre-registered deviations (recorded, shared by both arms)
 * - The §6 "while price is inside a POI" gate is dropped: it is identical
 *   for both arms (frozen POI logic), so it cannot favor either, and it
 *   would shrink the disagreement sample Gate B needs.
 * - Direction can never diverge (bias is shared), so divergence =
 *   trigger-fire mismatches; the >0.25R objective clause is inert by
 *   construction (objective shared).
 * - Paired unit for Gate B: (asset, execTF, bar). An arm that does not trade
 *   a unit contributes 0R to it — resting flat IS its decision there.
 *
 * ## Gates (thresholds fixed before the run, from §10)
 * A: divergence ≥ 10% of in-scope decisions (unit where ≥1 arm fires).
 * B: nested − crossTF mean delta ≥ +0.15R on the disagreement set, paired
 *    bootstrap 90% CI excluding 0, ≥ 50 resolved trades per side.
 * C: full-stream delta ≥ 0, and the disagreement-set delta positive in both
 *    window halves and in a majority of assets with disagreements.
 * D: complexity ledger — judged in the write-up.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pivotWindow } from "../../../src/lib/engine/analysis";
import { INTENT_MAX_HOLD_BARS } from "../../../src/lib/engine/hysteresis";
import { computeLiquidityPools } from "../../../src/lib/engine/liquidity";
import { UNIVERSE } from "../../../src/lib/engine/market";
import { resolveObjectives } from "../../../src/lib/engine/objectives";
import {
  computeMarketStructure,
  structureLean,
  type MarketStructure,
} from "../../../src/lib/engine/structure";
import type { Candle, PivotPoint } from "../../../src/lib/engine/types";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: bun run-spike.ts <dataDir>");
  process.exit(1);
}

// Execution TF → paired context TF (the INTENTS mapping) and horizon K.
const SCOPES = [
  { execTf: "15m", ctxTf: "1h", maxHold: INTENT_MAX_HOLD_BARS.scalp },
  { execTf: "1h", ctxTf: "4h", maxHold: INTENT_MAX_HOLD_BARS.intraday },
  { execTf: "4h", ctxTf: "1d", maxHold: INTENT_MAX_HOLD_BARS.swing },
] as const;

/** First execution bar index evaluated — everything earlier is lead-in. */
const LEAD_IN_BARS = 200;

function loadSeries(symbol: string, interval: string): Candle[] {
  return JSON.parse(readFileSync(join(dataDir, `${symbol}-${interval}.json`), "utf8"));
}

/** computePivots with an explicit window — the engine derives k from length. */
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

/** Bar-limited structure caches, keyed by prefix length (context prefixes repeat across exec bars). */
class StructureCache {
  private cache = new Map<string, MarketStructure>();
  constructor(private candles: Candle[]) {}
  atPrefix(len: number, fineOctave: boolean): MarketStructure {
    const key = `${len}:${fineOctave ? "f" : "s"}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const prefix = this.candles.slice(0, len);
    const kSwing = pivotWindow(prefix.length);
    const k = fineOctave ? Math.max(2, Math.floor(kSwing / 2)) : kSwing;
    const structure = computeMarketStructure(pivotsWithWindow(prefix, k));
    this.cache.set(key, structure);
    // Bound memory: prefixes are visited in ascending order, older ones never again.
    if (this.cache.size > 8) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    return structure;
  }
}

interface Decision {
  asset: string;
  execTf: string;
  barTime: number;
  barIndex: number;
  direction: "long" | "short";
  entry: number;
  stop: number;
  objective: number;
  /** WIN/LOSS resolved by first touch; CENSORED carries mark-to-horizon R. */
  outcome: "win" | "loss" | "censored";
  resultR: number;
}

function walkOutcome(
  execCandles: Candle[],
  fromIndex: number,
  direction: "long" | "short",
  entry: number,
  stop: number,
  objective: number,
  maxHold: number,
): { outcome: Decision["outcome"]; resultR: number } | null {
  const long = direction === "long";
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const r = (exit: number) => (long ? exit - entry : entry - exit) / risk;
  const bars = execCandles.slice(fromIndex + 1, fromIndex + 1 + maxHold);
  for (const bar of bars) {
    if (long ? bar.low <= stop : bar.high >= stop) return { outcome: "loss", resultR: r(stop) };
    if (long ? bar.high >= objective : bar.low <= objective)
      return { outcome: "win", resultR: r(objective) };
  }
  if (bars.length < maxHold) return null; // horizon not yet complete — drop the unit entirely (both arms)
  return { outcome: "censored", resultR: r(bars[bars.length - 1].close) };
}

/**
 * One arm's decisions for one (asset, scope): walk the execution bars; fire
 * on each NEW aligned internal CHoCH; grade with the frozen outcome walk.
 */
function runArm(
  asset: string,
  scope: (typeof SCOPES)[number],
  execCandles: Candle[],
  ctxCandles: Candle[],
  arm: "crossTf" | "nested",
): Decision[] {
  const decisions: Decision[] = [];
  const execCache = new StructureCache(execCandles);
  const ctxCache = new StructureCache(ctxCandles);

  // Context prefix length as-of each exec bar (bars whose CLOSE ≤ exec close).
  const ctxStep = ctxCandles.length > 1 ? ctxCandles[1].time - ctxCandles[0].time : 0;
  const execStep = execCandles.length > 1 ? execCandles[1].time - execCandles[0].time : 0;
  let ctxLen = 0;

  let prevEventKey: string | null = null;
  for (let t = LEAD_IN_BARS; t < execCandles.length; t++) {
    const execClose = execCandles[t].time + execStep;
    while (ctxLen < ctxCandles.length && ctxCandles[ctxLen].time + ctxStep <= execClose) ctxLen++;
    if (ctxLen < 50) continue;

    // Shared swing tier: the context structure's lean is the bias.
    const ctxStructure = ctxCache.atPrefix(ctxLen, false);
    const bias = structureLean(ctxStructure);

    // The one swapped component: where the internal tier comes from.
    const internal =
      arm === "crossTf" ? execCache.atPrefix(t + 1, false) : ctxCache.atPrefix(ctxLen, true);

    const event = internal.eventSwing;
    const eventKey = event ? `${event.time}:${event.kind}:${internal.event}` : null;
    const isNew = eventKey !== null && eventKey !== prevEventKey;
    prevEventKey = eventKey;
    if (!isNew || internal.event !== "choch" || bias === "none") continue;
    const eventDirection = event!.label === "HH" ? "long" : event!.label === "LL" ? "short" : null;
    if (eventDirection !== bias) continue;

    // Frozen trade construction.
    const entry = execCandles[t].close;
    const stopSwing = [...internal.swings]
      .reverse()
      .find((s) => s.kind === (bias === "long" ? "low" : "high") && s.time < event!.time);
    if (!stopSwing) continue;
    const stop = stopSwing.price;
    if (bias === "long" ? stop >= entry : stop <= entry) continue; // degenerate geometry

    const pools = computeLiquidityPools(ctxStructure);
    const objective = resolveObjectives(ctxStructure, pools, bias, entry)[0];
    if (!objective) continue; // no clean target → no decision (shared rule)

    const graded = walkOutcome(execCandles, t, bias, entry, stop, objective.price, scope.maxHold);
    if (!graded) continue;
    decisions.push({
      asset,
      execTf: scope.execTf,
      barTime: execCandles[t].time,
      barIndex: t,
      direction: bias,
      entry,
      stop,
      objective: objective.price,
      ...graded,
    });
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Run both arms over the universe.
// ---------------------------------------------------------------------------

interface Unit {
  key: string; // asset:execTf:barTime
  asset: string;
  barIndex: number;
  half: 1 | 2;
  crossTf: Decision | null;
  nested: Decision | null;
}

const units = new Map<string, Unit>();
const armTotals = { crossTf: 0, nested: 0 };

for (const entry of UNIVERSE) {
  const symbol = `${entry.ticker}USDT`;
  for (const scope of SCOPES) {
    let execCandles: Candle[];
    let ctxCandles: Candle[];
    try {
      execCandles = loadSeries(symbol, scope.execTf);
      ctxCandles = loadSeries(symbol, scope.ctxTf);
    } catch {
      console.error(`missing data: ${symbol} ${scope.execTf}/${scope.ctxTf}`);
      continue;
    }
    const mid = LEAD_IN_BARS + Math.floor((execCandles.length - LEAD_IN_BARS) / 2);
    for (const arm of ["crossTf", "nested"] as const) {
      for (const d of runArm(entry.ticker, scope, execCandles, ctxCandles, arm)) {
        armTotals[arm]++;
        const key = `${d.asset}:${d.execTf}:${d.barTime}`;
        const unit = units.get(key) ?? {
          key,
          asset: d.asset,
          barIndex: d.barIndex,
          half: (d.barIndex < mid ? 1 : 2) as 1 | 2,
          crossTf: null,
          nested: null,
        };
        unit[arm] = d;
        units.set(key, unit);
      }
    }
  }
}

const all = [...units.values()];
const agreement = all.filter((u) => u.crossTf && u.nested);
const disagreement = all.filter((u) => !u.crossTf || !u.nested);

// Gate A — divergence over in-scope decisions (units where ≥1 arm fired).
const divergencePct = all.length ? (disagreement.length / all.length) * 100 : 0;

// Paired unit R: an arm not trading a unit contributes 0.
const unitR = (u: Unit, arm: "crossTf" | "nested") => u[arm]?.resultR ?? 0;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const disagreementDeltas = disagreement.map((u) => unitR(u, "nested") - unitR(u, "crossTf"));
const fullDeltas = all.map((u) => unitR(u, "nested") - unitR(u, "crossTf"));

// Gate B — resolved (non-censored) trades per side inside the disagreement set.
const resolvedIn = (arm: "crossTf" | "nested") =>
  disagreement.filter((u) => u[arm] && u[arm]!.outcome !== "censored").length;

// Paired bootstrap over disagreement units, 10k resamples, 90% CI.
function bootstrapCi(deltas: number[], iterations = 10_000): [number, number] {
  if (deltas.length === 0) return [0, 0];
  let seed = 0xdeadbeef; // deterministic LCG so the run is reproducible
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < deltas.length; j++) sum += deltas[Math.floor(rand() * deltas.length)];
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iterations * 0.05)], means[Math.floor(iterations * 0.95)]];
}
const [ciLow, ciHigh] = bootstrapCi(disagreementDeltas);

// Gate C — halves and per-asset breakdown on the disagreement set.
const halfDelta = (half: 1 | 2) =>
  mean(
    disagreement
      .filter((u) => u.half === half)
      .map((u) => unitR(u, "nested") - unitR(u, "crossTf")),
  );
const perAsset = new Map<string, number[]>();
for (const u of disagreement) {
  const arr = perAsset.get(u.asset) ?? [];
  arr.push(unitR(u, "nested") - unitR(u, "crossTf"));
  perAsset.set(u.asset, arr);
}
const assetsPositive = [...perAsset.values()].filter((xs) => mean(xs) > 0).length;

// Per-arm raw expectancy for context.
const armStats = (arm: "crossTf" | "nested") => {
  const trades = all.map((u) => u[arm]).filter((d): d is Decision => d !== null);
  const wins = trades.filter((d) => d.outcome === "win").length;
  const losses = trades.filter((d) => d.outcome === "loss").length;
  const censored = trades.filter((d) => d.outcome === "censored").length;
  return {
    trades: trades.length,
    wins,
    losses,
    censored,
    meanR: mean(trades.map((d) => d.resultR)),
  };
};

const report = {
  window: JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8"))["BTCUSDT-1h"],
  population: {
    inScopeUnits: all.length,
    bothFired: agreement.length,
    disagreement: disagreement.length,
    crossTfDecisions: armTotals.crossTf,
    nestedDecisions: armTotals.nested,
  },
  arms: { crossTf: armStats("crossTf"), nested: armStats("nested") },
  gateA: {
    divergencePct: Number(divergencePct.toFixed(1)),
    threshold: 10,
    pass: divergencePct >= 10,
  },
  gateB: {
    meanDeltaR: Number(mean(disagreementDeltas).toFixed(3)),
    threshold: 0.15,
    ci90: [Number(ciLow.toFixed(3)), Number(ciHigh.toFixed(3))],
    resolvedCrossTf: resolvedIn("crossTf"),
    resolvedNested: resolvedIn("nested"),
    sampleFloor: 50,
    pass:
      mean(disagreementDeltas) >= 0.15 &&
      ciLow > 0 &&
      resolvedIn("crossTf") >= 50 &&
      resolvedIn("nested") >= 50,
  },
  gateC: {
    fullStreamDeltaR: Number(mean(fullDeltas).toFixed(3)),
    half1DeltaR: Number(halfDelta(1).toFixed(3)),
    half2DeltaR: Number(halfDelta(2).toFixed(3)),
    assetsWithDisagreements: perAsset.size,
    assetsNestedPositive: assetsPositive,
    pass:
      mean(fullDeltas) >= 0 &&
      halfDelta(1) > 0 &&
      halfDelta(2) > 0 &&
      assetsPositive > perAsset.size / 2,
  },
};

console.log(JSON.stringify(report, null, 2));
const verdict =
  report.gateA.pass && report.gateB.pass && report.gateC.pass
    ? "ADOPT NESTED (subject to Gate D complexity ledger)"
    : "CROSS-TF WINS (incumbent retained)";
console.log(`\nVERDICT: ${verdict}`);
