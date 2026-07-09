// Turns the deterministic signal engine output into a grounded prompt for the
// BYOK AI analyst. The model is told to reason ONLY from these numbers — it has
// no market feed of its own, so every figure it cites must come from here.

import type { IntentAssessment } from "@/lib/engine/intent";
import type { LiquidityPool, LiquiditySweep } from "@/lib/engine/liquidity";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { EqualLevel, SwingPoint } from "@/lib/engine/structure";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { TrendLines } from "@/lib/engine/analysis";
import type { BaseZone } from "@/lib/engine/zones";
import type { Candle } from "@/lib/engine/types";

/** Default instruction when the user just hits "Run analysis" (no question). */
export const MEMO_INSTRUCTION =
  "Write a concise analyst memo for this setup, grounded strictly in the data above.";

function humanize(value: string): string {
  return value.replaceAll("-", " ");
}

function num(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 8;
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

/**
 * The structure actually drawn on the chart — support/resistance trend-line
 * levels, demand/supply base zones, and volume vs its 20-bar average. This is
 * the material the engine's verdict is NOT expressed in, so the analyst can
 * cross-check the plan against it.
 */
export interface ChartStructure {
  support: number | null;
  resistance: number | null;
  zones: BaseZone[];
  latestVolume: number | null;
  avgVolume20: number | null;
}

/** Distil the chart primitives into the compact structure fed to the model. */
export function buildChartStructure(
  candles: Candle[],
  trendLines: TrendLines,
  zones: BaseZone[],
): ChartStructure {
  const recent = candles.slice(-20);
  const avgVolume20 =
    recent.length > 0 ? recent.reduce((sum, c) => sum + c.volume, 0) / recent.length : null;
  return {
    support: trendLines.support.at(-1)?.value ?? null,
    resistance: trendLines.resistance.at(-1)?.value ?? null,
    zones,
    latestVolume: candles.at(-1)?.volume ?? null,
    avgVolume20,
  };
}

function chartStructureBlock(s: ChartStructure): string {
  const zones = s.zones.length
    ? s.zones
        .map(
          (z) =>
            `  - ${z.kind.toUpperCase()} ${num(z.priceLow)}–${num(z.priceHigh)} (${z.freshness})`,
        )
        .join("\n")
    : "  - none detected on this timeframe";
  const volume =
    s.latestVolume !== null && s.avgVolume20 !== null && s.avgVolume20 > 0
      ? `latest bar ${num(s.latestVolume)} vs 20-bar avg ${num(s.avgVolume20)} (${(s.latestVolume / s.avgVolume20).toFixed(2)}× average)`
      : "not available";
  return [
    `- Support trend line: ${s.support !== null ? num(s.support) : "none detected"}`,
    `- Resistance trend line: ${s.resistance !== null ? num(s.resistance) : "none detected"}`,
    `- Demand/supply zones (as drawn on the chart):\n${zones}`,
    `- Volume: ${volume}`,
  ].join("\n");
}

function swingText(swing: SwingPoint | null): string {
  if (!swing) return "none formed yet";
  return `${swing.label ?? "first swing"} at ${num(swing.price)}`;
}

function structureLine(s: SignalEvaluation["structure"]): string {
  const event =
    s.event && s.eventSwing
      ? `${s.event === "bos" ? "BOS (trend-extending break)" : "CHoCH (break against the trend)"} at ${num(s.eventSwing.price)}`
      : "none yet";
  return `${s.trend} — last swing high ${swingText(s.lastHigh)}, last swing low ${swingText(s.lastLow)}; latest structural break: ${event}`;
}

function equalLevelsText(levels: EqualLevel[]): string {
  if (levels.length === 0) return "none";
  return levels.map((l) => `${num(l.price)} (${l.swings.length} touches)`).join(", ");
}

function liquidityText(pools: LiquidityPool[], sweeps: LiquiditySweep[]): string {
  // A swept pool's stops are gone even when swing bookkeeping still reads it
  // as intact — never present one to the analyst as a live magnet.
  const sweptPools = new Set(sweeps.map((s) => s.pool));
  const intact = pools.filter((p) => p.intact && !sweptPools.has(p));
  if (intact.length === 0) return "none intact";
  return intact
    .map(
      (p) =>
        `${p.side.toUpperCase()} at ${num(p.price)} (confidence ${p.confidence}/100, ${p.cluster.swings.length} touches)`,
    )
    .join("; ");
}

function sweepsText(sweeps: LiquiditySweep[]): string {
  if (sweeps.length === 0) return "none";
  return sweeps
    .map(
      (s) =>
        `${s.side.toUpperCase()} at ${num(s.pool.price)} swept (wick ${num(s.extreme)}, closed back at ${num(s.close)})`,
    )
    .join("; ");
}

function evaluationBlock(e: SignalEvaluation): string {
  const lines = [
    `- Decision: ${humanize(e.decision)} (direction: ${e.direction})`,
    `- Setup: ${humanize(e.setupType)} · Regime: ${humanize(e.regime)} · Confidence: ${e.confidence}/100`,
    `- Swing structure (HH/HL/LH/LL over validated swing legs): ${structureLine(e.structure)}`,
    `- Equal levels (matching swings where stop liquidity rests): equal highs ${equalLevelsText(e.structure.equalHighs)}; equal lows ${equalLevelsText(e.structure.equalLows)}`,
    `- Liquidity pools (untapped stop clusters; price is often drawn toward them): ${liquidityText(e.liquidity, e.liquiditySweeps)}`,
    `- Liquidity sweeps (stop hunts: wick through a pool, close back inside): ${sweepsText(e.liquiditySweeps)}`,
    `- Reason: ${e.reason}`,
    `- Risk plan: entry zone ${num(e.risk.entryLow)}–${num(e.risk.entryHigh)}, stop ${num(e.risk.stop)}, target 1 ${num(e.risk.target1)}, target 2 ${num(e.risk.target2)}`,
    `- Sizing: ${e.risk.positionSize} units, max loss $${num(e.risk.maxDollarLoss)}, reward/risk to T1 ${num(e.risk.rewardRisk1)}R (to T2 ${num(e.risk.rewardRisk2)}R)`,
    `- Backtest: ${e.backtest.totalTrades} trades, ${num(e.backtest.winRate)}% win rate, expectancy ${num(e.backtest.expectancy)}R${e.backtest.lowSample ? " (low sample — treat with caution)" : ""}`,
  ];
  if (e.noTradeReasons.length) {
    lines.push(`- Blockers: ${e.noTradeReasons.join("; ")}`);
  }
  const components = e.components
    .map(
      (c) => `  - ${c.name} [${c.status} ${c.score >= 0 ? "+" : ""}${c.score}]: ${c.explanation}`,
    )
    .join("\n");
  lines.push(`- Components:\n${components}`);
  return lines.join("\n");
}

function assessmentBlock(a: IntentAssessment): string {
  const checklist = a.checklist
    .map((item) => `  - [${item.done ? "x" : " "}] ${item.label}: ${item.detail}`)
    .join("\n");
  const triggers = a.triggers.map((t) => `  - ${t}`).join("\n");
  return [
    `- Objective: ${a.definition.label} (${a.definition.contextTimeframe} context / ${a.definition.executionTimeframe} trigger, holds ${a.definition.horizon})`,
    `- Verdict: ${a.verdict} — ${a.headline}`,
    `- Summary: ${a.summary}`,
    `- Direction: ${a.direction}${a.isCounterTrend ? " (counter-trend, reduced size)" : ""} · Confidence: ${a.confidence}/100`,
    `- Bias: context ${a.contextBias}, execution ${a.executionBias}`,
    `- Confirmation checklist:\n${checklist}`,
    triggers ? `- What changes this answer:\n${triggers}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the system prompt: the analyst persona plus a full data dump of the
 * current signal. `detailed` (from the panel's reasoning toggle) asks for a
 * slightly deeper read while keeping the memo tight.
 */
export function buildAnalystSystem(
  symbol: string,
  timeframe: TokenTimeframe,
  evaluation: SignalEvaluation,
  assessment: IntentAssessment | null,
  detailed: boolean,
  structure: ChartStructure | null = null,
): string {
  const parts = [
    `You are the AI analyst inside a crypto trading dashboard, acting as a SECOND analyst reviewing the engine's work on ${symbol}/USDT (${timeframe}).`,
    "",
    "You are given two things: (1) the engine's plan and its check components, and (2) the chart structure actually drawn on the chart — support/resistance trend-line levels, demand/supply zones, and volume. Your job is to cross-check one against the other.",
    "",
    "Rules:",
    "- Use ONLY the data provided below. You have no live market feed; never invent prices, levels, zones, swing points, or news. If something isn't in the data, say you don't have it rather than guessing.",
    "- Cross-check the plan against the chart structure and call out conflicts explicitly: e.g. a supply zone between entry and target capping upside, a demand zone or S/R level sitting on the stop, resistance just above entry, or volume that doesn't support the move — and say how each changes your read.",
    "- You MAY disagree with the engine's verdict when the structure warrants it. Be specific about why, citing the actual levels and zone ranges.",
    "- Be direct. Reference concrete numbers (entry, stop, targets, R multiples, zone ranges, S/R levels, volume vs average).",
    detailed
      ? "- Give a thorough read of the evidence, but stay under ~250 words."
      : "- Keep it tight — under ~180 words.",
    "- Format with Markdown: `###` headings, `-` bullets, and `**bold**` for key levels. No tables.",
    "",
    `## Engine evaluation (${timeframe})`,
    evaluationBlock(evaluation),
  ];
  if (structure) {
    parts.push("", "## Chart structure (drawn on the chart)", chartStructureBlock(structure));
  }
  if (assessment) {
    parts.push("", "## Trader's active objective", assessmentBlock(assessment));
  }
  return parts.join("\n");
}
