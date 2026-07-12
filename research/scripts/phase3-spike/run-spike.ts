/**
 * Phase 3 spike — the pre-registered comparison from research/phase3-spike.md.
 *
 *   bun run research/scripts/phase3-spike/run-spike.ts <dataDir>
 *
 * Question: does the H-LB challenger trigger (a closed execution-bar CLOSE
 * through the leg-scoped fine-tier counter-trend pivot — see leg-scope.ts)
 * produce materially better confirmation-mode decisions than the CHoCH
 * incumbent (a pivot-confirmed new CHoCH on the execution TF's own
 * structure, knowable `k` bars after the break)? CHoCH wins ties, wins on
 * insufficient sample, wins when the effect is immaterial.
 *
 * ## Frozen, shared by both arms (isolation — one variable only)
 * - Swing tier & bias: the context TF's structure lean (structureLean), as-of
 *   the execution bar, from bar-limited context prefixes.
 * - Objective: resolveObjectives over the context structure + pools, at the
 *   trigger bar's close; the preferred candidate. Empty → no decision.
 * - Entry model: the trigger bar's close (both arms trigger at a bar close —
 *   CHoCH once the pivot confirms `k` bars later, H-LB immediately).
 * - Stop RULE: the internal tier's most recent opposite-kind swing before
 *   the trigger. The rule is frozen; its value flows from each arm's own
 *   internal tier — CHoCH reads the standard-window exec structure, H-LB
 *   reads the fine-window exec structure (leg-scope.ts's `findLegStop`).
 * - Outcome walk: execution bars after the trigger bar, stop checked before
 *   objective within a bar (walkExitLevels convention); horizon K =
 *   INTENT_MAX_HOLD_BARS of the execution TF's intent (16/24/42). Unresolved
 *   at K = censored, scored at mark-to-horizon R (never silently dropped).
 *
 * ## The one swapped component — the internal-shift TRIGGER
 * - CHoCH (incumbent): internal = computeMarketStructure(computePivots(exec
 *   prefix)) — standard pivot window. Fires when the internal tier's latest
 *   event becomes a NEW CHoCH in the bias direction. Knowable `k` bars after
 *   the break (pivot confirmation lag).
 * - H-LB (challenger): internal = fine-tier pivots (half window) on the SAME
 *   exec chart (never the context chart — that is phase2's already-spiked
 *   "nested" hypothesis). Fires on the first bar CLOSE through the
 *   leg-scoped anchor (leg-scope.ts's `findLegOrigin`). Knowable at that
 *   bar's own close — no confirmation wait.
 *
 * ## Pre-registered deviations (recorded, shared by both arms)
 * - The §6 "while price is inside a POI" gate is dropped: identical for both
 *   arms (frozen POI logic), so it cannot favor either, and it would shrink
 *   the disagreement sample Gate B needs. Same deviation as phase2.
 * - Direction can never diverge (bias is shared), so divergence = trigger-
 *   fire mismatches; the >0.25R objective-difference epsilon is inert by
 *   construction (objective shared) — same as phase2.
 * - Paired unit for Gate B: (asset, execTF, bar). An arm that does not trade
 *   a unit contributes 0R to it — resting flat IS its decision there.
 *
 * ## Gates (thresholds fixed before the run, from phase3-spike.md)
 * A: divergence ≥ 10% of in-scope decisions (unit where ≥1 arm fires).
 * B: H-LB − CHoCH mean delta ≥ +0.15R on the disagreement set, paired
 *    bootstrap 90% CI excluding 0, ≥ 50 resolved trades per side.
 * C: full-stream delta ≥ 0, and the disagreement-set delta positive in both
 *    window halves and in a majority of assets with disagreements.
 * D: complexity ledger — judged in the write-up, not computed here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computePivots, pivotWindow } from "../../../src/lib/engine/analysis";
import { INTENT_MAX_HOLD_BARS } from "../../../src/lib/engine/hysteresis";
import { computeLiquidityPools } from "../../../src/lib/engine/liquidity";
import { UNIVERSE } from "../../../src/lib/engine/market";
import { resolveObjectives } from "../../../src/lib/engine/objectives";
import {
  computeMarketStructure,
  structureLean,
  type MarketStructure,
} from "../../../src/lib/engine/structure";
import type { Candle } from "../../../src/lib/engine/types";
import { findLegOrigin, findLegStop, originKey, pivotsWithWindow } from "./leg-scope";

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

/** Bar-limited exec structure cache: standard window (CHoCH) or fine window (H-LB). */
class ExecStructureCache {
  private cache = new Map<string, MarketStructure>();
  constructor(private candles: Candle[]) {}
  atPrefix(len: number, fine: boolean): MarketStructure {
    const key = `${len}:${fine ? "f" : "s"}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const prefix = this.candles.slice(0, len);
    const kStd = pivotWindow(prefix.length);
    const k = fine ? Math.max(2, Math.floor(kStd / 2)) : kStd;
    const structure = computeMarketStructure(pivotsWithWindow(prefix, k));
    this.cache.set(key, structure);
    if (this.cache.size > 8) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    return structure;
  }
}

/** Bar-limited context structure cache — standard window only (no fine tier used here). */
class CtxStructureCache {
  private cache = new Map<number, MarketStructure>();
  constructor(private candles: Candle[]) {}
  atPrefix(len: number): MarketStructure {
    const hit = this.cache.get(len);
    if (hit) return hit;
    const prefix = this.candles.slice(0, len);
    const structure = computeMarketStructure(computePivots(prefix));
    this.cache.set(len, structure);
    if (this.cache.size > 4) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
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

/** Shared per-bar walk state: context prefix stepping + bias, identical for both arms. */
function* walkBars(execCandles: Candle[], ctxCandles: Candle[], ctxCache: CtxStructureCache) {
  const ctxStep = ctxCandles.length > 1 ? ctxCandles[1].time - ctxCandles[0].time : 0;
  const execStep = execCandles.length > 1 ? execCandles[1].time - execCandles[0].time : 0;
  let ctxLen = 0;
  for (let t = LEAD_IN_BARS; t < execCandles.length; t++) {
    const execClose = execCandles[t].time + execStep;
    while (ctxLen < ctxCandles.length && ctxCandles[ctxLen].time + ctxStep <= execClose) ctxLen++;
    if (ctxLen < 50) continue;
    const ctxStructure = ctxCache.atPrefix(ctxLen);
    const bias = structureLean(ctxStructure);
    yield { t, ctxStructure, bias };
  }
}

function runChochArm(
  asset: string,
  scope: (typeof SCOPES)[number],
  execCandles: Candle[],
  ctxCandles: Candle[],
): Decision[] {
  const decisions: Decision[] = [];
  const execCache = new ExecStructureCache(execCandles);
  const ctxCache = new CtxStructureCache(ctxCandles);

  let prevEventKey: string | null = null;
  for (const { t, ctxStructure, bias } of walkBars(execCandles, ctxCandles, ctxCache)) {
    const internal = execCache.atPrefix(t + 1, false);
    const event = internal.eventSwing;
    const eventKey = event ? `${event.time}:${event.kind}:${internal.event}` : null;
    const isNew = eventKey !== null && eventKey !== prevEventKey;
    prevEventKey = eventKey;
    if (!isNew || internal.event !== "choch" || bias === "none") continue;
    const eventDirection = event!.label === "HH" ? "long" : event!.label === "LL" ? "short" : null;
    if (eventDirection !== bias) continue;

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

function runHlbArm(
  asset: string,
  scope: (typeof SCOPES)[number],
  execCandles: Candle[],
  ctxCandles: Candle[],
): Decision[] {
  const decisions: Decision[] = [];
  const execCache = new ExecStructureCache(execCandles);
  const ctxCache = new CtxStructureCache(ctxCandles);

  let prevFiredKey: string | null = null;
  for (const { t, ctxStructure, bias } of walkBars(execCandles, ctxCandles, ctxCache)) {
    if (bias === "none") continue;

    const fine = execCache.atPrefix(t + 1, true);
    const origin = findLegOrigin(fine.swings, bias);
    if (!origin) {
      prevFiredKey = null; // internal realigned — a later origin fires fresh
      continue;
    }

    const close = execCandles[t].close;
    const fired = bias === "long" ? close > origin.price : close < origin.price;
    if (!fired) continue;
    const key = originKey(origin);
    if (key === prevFiredKey) continue; // already fired this exact anchor — no re-fire on the same shelf
    prevFiredKey = key;

    const entry = close;
    const stopSwing = findLegStop(fine.swings, bias, execCandles[t].time);
    if (!stopSwing) continue;
    const stop = stopSwing.price;
    if (bias === "long" ? stop >= entry : stop <= entry) continue; // degenerate geometry

    const pools = computeLiquidityPools(ctxStructure);
    const objective = resolveObjectives(ctxStructure, pools, bias, entry)[0];
    if (!objective) continue;

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
  choch: Decision | null;
  hlb: Decision | null;
}

const units = new Map<string, Unit>();
const armTotals = { choch: 0, hlb: 0 };

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
    const armRunners = { choch: runChochArm, hlb: runHlbArm } as const;
    for (const arm of ["choch", "hlb"] as const) {
      for (const d of armRunners[arm](entry.ticker, scope, execCandles, ctxCandles)) {
        armTotals[arm]++;
        const key = `${d.asset}:${d.execTf}:${d.barTime}`;
        const unit = units.get(key) ?? {
          key,
          asset: d.asset,
          barIndex: d.barIndex,
          half: (d.barIndex < mid ? 1 : 2) as 1 | 2,
          choch: null,
          hlb: null,
        };
        unit[arm] = d;
        units.set(key, unit);
      }
    }
  }
}

const all = [...units.values()];
const agreement = all.filter((u) => u.choch && u.hlb);
const disagreement = all.filter((u) => !u.choch || !u.hlb);

// Gate A — divergence over in-scope decisions (units where ≥1 arm fired).
const divergencePct = all.length ? (disagreement.length / all.length) * 100 : 0;

// Paired unit R: an arm not trading a unit contributes 0.
const unitR = (u: Unit, arm: "choch" | "hlb") => u[arm]?.resultR ?? 0;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const disagreementDeltas = disagreement.map((u) => unitR(u, "hlb") - unitR(u, "choch"));
const fullDeltas = all.map((u) => unitR(u, "hlb") - unitR(u, "choch"));

// Gate B — resolved (non-censored) trades per side inside the disagreement set.
const resolvedIn = (arm: "choch" | "hlb") =>
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
  mean(disagreement.filter((u) => u.half === half).map((u) => unitR(u, "hlb") - unitR(u, "choch")));
const perAsset = new Map<string, number[]>();
for (const u of disagreement) {
  const arr = perAsset.get(u.asset) ?? [];
  arr.push(unitR(u, "hlb") - unitR(u, "choch"));
  perAsset.set(u.asset, arr);
}
const assetsPositive = [...perAsset.values()].filter((xs) => mean(xs) > 0).length;

// Per-arm raw expectancy for context.
const armStats = (arm: "choch" | "hlb") => {
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
    chochDecisions: armTotals.choch,
    hlbDecisions: armTotals.hlb,
  },
  arms: { choch: armStats("choch"), hlb: armStats("hlb") },
  gateA: {
    divergencePct: Number(divergencePct.toFixed(1)),
    threshold: 10,
    pass: divergencePct >= 10,
  },
  gateB: {
    meanDeltaR: Number(mean(disagreementDeltas).toFixed(3)),
    threshold: 0.15,
    ci90: [Number(ciLow.toFixed(3)), Number(ciHigh.toFixed(3))],
    resolvedChoch: resolvedIn("choch"),
    resolvedHlb: resolvedIn("hlb"),
    sampleFloor: 50,
    pass:
      mean(disagreementDeltas) >= 0.15 &&
      ciLow > 0 &&
      resolvedIn("choch") >= 50 &&
      resolvedIn("hlb") >= 50,
  },
  gateC: {
    fullStreamDeltaR: Number(mean(fullDeltas).toFixed(3)),
    half1DeltaR: Number(halfDelta(1).toFixed(3)),
    half2DeltaR: Number(halfDelta(2).toFixed(3)),
    assetsWithDisagreements: perAsset.size,
    assetsHlbPositive: assetsPositive,
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
    ? "ADOPT H-LB (subject to Gate D complexity ledger)"
    : "CHOCH WINS (incumbent retained)";
console.log(`\nVERDICT: ${verdict}`);
