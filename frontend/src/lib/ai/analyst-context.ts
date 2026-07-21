// Turns the deterministic signal engine output into a grounded prompt for the
// BYOK AI analyst. The model is told to reason ONLY from these numbers — it has
// no market feed of its own, so every figure it cites must come from here.

import type {
  BreadthContext,
  ContextEventItem,
  ExternalContext,
  RelativeContext,
  UpcomingCatalystItem,
} from "@/lib/engine/external-context";
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

export function humanize(value: string): string {
  return value.replaceAll("-", " ");
}

/**
 * Compact numeric formatter shared by every grounded prompt: fixed to a
 * price-appropriate precision, trailing zeros stripped. Exported so the desk-
 * review evidence pack renders the same figures the analyst prompt does.
 */
export function num(value: number): string {
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

export function chartStructureBlock(s: ChartStructure): string {
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

export function structureLine(s: SignalEvaluation["structure"]): string {
  const event =
    s.event && s.eventSwing
      ? `${s.event === "bos" ? "BOS (trend-extending break)" : "CHoCH (break against the trend)"} at ${num(s.eventSwing.price)}`
      : "none yet";
  return `${s.trend} — last swing high ${swingText(s.lastHigh)}, last swing low ${swingText(s.lastLow)}; latest structural break: ${event}`;
}

export function equalLevelsText(levels: EqualLevel[]): string {
  if (levels.length === 0) return "none";
  return levels.map((l) => `${num(l.price)} (${l.swings.length} touches)`).join(", ");
}

export function liquidityText(pools: LiquidityPool[], sweeps: LiquiditySweep[]): string {
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

export function sweepsText(sweeps: LiquiditySweep[]): string {
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
    `- Backtest: ${e.backtest.totalTrades} trades, ${num(e.backtest.winRate)}% win rate, expectancy ${num(e.backtest.expectancy)}R (in-sample replay on this chart's own history, not forward-tested${e.backtest.lowSample ? "; also low sample — treat with caution" : ""})`,
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

/** Minimal hold-state shape the analyst needs — see `DisplayIntentAssessment["hold"]`. */
export interface VerdictHoldInfo {
  isHeld: boolean;
  heldAt: string;
  adoptedBecause?: string;
}

function ageFrom(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function assessmentBlock(a: IntentAssessment, hold?: VerdictHoldInfo | null): string {
  const checklist = a.checklist
    .map((item) => `  - [${item.done ? "x" : " "}] ${item.label}: ${item.detail}`)
    .join("\n");
  const triggers = a.triggers.map((t) => `  - ${t}`).join("\n");
  // The engine holds a verdict's Verdict/Summary/Direction/Triggers wording
  // stable until its own release trigger fires, so a reader doesn't watch it
  // flicker on every refresh — but the checklist and bias line below are
  // re-derived live every time, so they can legitimately show a different
  // direction than the held call once the setup has moved without yet
  // breaking the trigger. Without this line the model has no way to tell
  // "standing decision, live supporting data" apart from "the engine
  // contradicted itself," and writes a confused memo either way.
  const statusLine = !hold
    ? null
    : hold.isHeld
      ? `- Status: HELD — adopted ${ageFrom(hold.heldAt)} ago and standing until its own invalidation/upgrade trigger fires (see "What changes this answer"). The checklist and bias line below are live and can already point a different direction than this held call — that's the setup drifting since adoption, not an engine contradiction; say so explicitly rather than treating both as equally current.`
      : `- Status: fresh — (re)computed just now${hold.adoptedBecause ? ` because: ${hold.adoptedBecause}` : ""}; matches the checklist and bias below.`;
  return [
    `- Objective: ${a.definition.label} (${a.definition.contextTimeframe} context / ${a.definition.executionTimeframe} trigger, holds ${a.definition.horizon})`,
    statusLine,
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

// ── External market context (secondary evidence) ────────────────────────────

/**
 * Hard cap on the external-context section. The BYOK client sends the system
 * prompt whole with no truncation of its own, so this is the one guard between
 * a busy news week and an oversized request. When over budget, items drop in
 * fixed priority order (market-wide events → older high-impact → older recent
 * catalysts); breadth and the top-2 of each bucket always survive.
 */
export const EXTERNAL_CONTEXT_CHAR_BUDGET = 2_500;
const EVENT_TITLE_MAX = 140;

function truncateTitle(title: string): string {
  return title.length <= EVENT_TITLE_MAX ? title : `${title.slice(0, EVENT_TITLE_MAX - 1)}…`;
}

function staleSuffix(p: { stale: boolean; asOf: string }): string {
  return p.stale ? ` (STALE, as of ${p.asOf})` : "";
}

function compactUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(0)}B`;
  return `$${num(value)}`;
}

function signedPct(value: number, unit = "%"): string {
  return `${value >= 0 ? "+" : ""}${num(value)}${unit}`;
}

export function breadthLine(b: BreadthContext): string {
  const bits: string[] = [];
  if (b.btcRegime) bits.push(`BTC regime ${b.btcRegime}`);
  if (b.btcChange24hPct !== null) bits.push(`BTC 24h ${signedPct(b.btcChange24hPct)}`);
  if (b.btcDominancePct !== null) {
    bits.push(
      `BTC dominance ${num(b.btcDominancePct)}%${
        b.btcDominanceDelta24hPp !== null
          ? ` (24h ${signedPct(b.btcDominanceDelta24hPp, "pp")})`
          : ""
      }`,
    );
  }
  if (b.totalMcapUsd !== null) {
    bits.push(
      `total crypto mcap ${compactUsd(b.totalMcapUsd)}${
        b.mcapChange24hPct !== null ? ` (24h ${signedPct(b.mcapChange24hPct)})` : ""
      }`,
    );
  }
  if (b.fearGreed !== null) bits.push(`Fear & Greed ${b.fearGreed} (${b.fearGreedLabel})`);
  return `- Market backdrop [${b.provenance.source}, as of ${ageFrom(b.provenance.asOf)} ago]${staleSuffix(b.provenance)}: ${bits.join("; ")}.`;
}

/**
 * Retrospective relative-strength line. Extracted verbatim from
 * `externalContextBlock` (byte-identical output) so both the analyst prompt and
 * the desk-review evidence pack read the same figures from one source.
 */
export function relativeLine(symbol: string, r: RelativeContext): string {
  const ratioText =
    r.ratio !== null
      ? `; ${symbol}/BTC ratio ${num(r.ratio)}${
          r.ratioChange7dPct !== null ? ` (7d ${signedPct(r.ratioChange7dPct)})` : ""
        }`
      : "";
  return `- Relative strength vs BTC [${r.provenance.source}, as of ${ageFrom(r.provenance.asOf)} ago]${staleSuffix(r.provenance)}: 24h ${signedPct(r.rsBtc24hPp, "pp")}, 7d ${signedPct(r.rsBtc7dPp, "pp")}${
    r.corrBtc7d !== null ? `, 7d correlation ${num(r.corrBtc7d)}` : ""
  }${ratioText}.`;
}

export function eventLine(e: ContextEventItem): string {
  const day = e.publishedAt.slice(0, 10);
  return `  - [${e.severity}/${e.kind}] ${day}, ${ageFrom(e.publishedAt)} ago (${e.source}): "${truncateTitle(e.title)}"`;
}

export function upcomingLine(e: UpcomingCatalystItem): string {
  const cred: string[] = [];
  if (e.confidencePct !== null) cred.push(`confidence ${e.confidencePct}%`);
  if (e.votes !== null) cred.push(`${e.votes} votes`);
  const credText = cred.length ? ` (${cred.join(", ")})` : "";
  const unlockNote =
    e.kind === "unlock"
      ? e.percentOfSupply !== null
        ? ` — ${num(e.percentOfSupply)}% of supply unlocks (quantified supply catalyst)`
        : " — unlock scheduled; SIZE UNKNOWN (treat as a scheduling fact, not a supply-pressure signal)"
      : "";
  return `  - ${e.occursAt.slice(0, 10)} [${e.kind}] ${e.symbol}: "${truncateTitle(e.title)}"${credText}${unlockNote}`;
}

/**
 * Render the external-context section under its two organizing questions.
 * Returns null when there is nothing worth showing — the section (and its
 * rules) must vanish entirely rather than present an empty scaffold.
 */
function externalContextBlock(ctx: ExternalContext): string | null {
  const hasRetro =
    ctx.breadth !== null ||
    ctx.relative !== null ||
    (ctx.recentCatalysts?.length ?? 0) > 0 ||
    (ctx.recentHighImpact?.length ?? 0) > 0;
  const hasForward = (ctx.upcoming?.length ?? 0) > 0 || (ctx.marketEvents?.length ?? 0) > 0;
  if (!hasRetro && !hasForward) return null;

  // Progressive trimming: drop lowest-priority items until under budget.
  let marketEvents = ctx.marketEvents ?? [];
  let highImpact = ctx.recentHighImpact ?? [];
  let catalysts = ctx.recentCatalysts ?? [];
  const upcoming = ctx.upcoming ?? [];

  const render = (): string => {
    const parts: string[] = [];
    parts.push("### What might explain the current move? (retrospective — treat as uncertain)");
    if (ctx.breadth) parts.push(breadthLine(ctx.breadth));
    if (ctx.relative) parts.push(relativeLine(ctx.symbol, ctx.relative));
    if (catalysts.length) {
      parts.push(
        `- Recent catalysts for ${ctx.symbol}, last 48h [news feeds]:`,
        ...catalysts.map(eventLine),
        "  (these are plausible contributors, not established causes)",
      );
    }
    if (highImpact.length) {
      parts.push(
        `- High-impact context for ${ctx.symbol}, last 7 days [news feeds]:`,
        ...highImpact.map(eventLine),
      );
    }
    if (!ctx.breadth && !ctx.relative && !catalysts.length && !highImpact.length) {
      parts.push("- Nothing notable on record for this window.");
    }
    if (upcoming.length || marketEvents.length) {
      parts.push("", "### What matters next (next 7 days)");
      if (upcoming.length) {
        parts.push(
          `- Upcoming events for ${ctx.symbol} [calendar]:`,
          ...upcoming.map(upcomingLine),
        );
      }
      if (marketEvents.length) {
        parts.push("- Market-wide (BTC/ETH) events:", ...marketEvents.map(upcomingLine));
      }
    }
    return parts.join("\n");
  };

  let text = render();
  // Drop order: market-wide events, then older high-impact beyond the top 2,
  // then older recent catalysts beyond the top 2. Upcoming symbol events and
  // breadth/relative are never dropped — they are the section's reason to exist.
  const trims: Array<() => void> = [
    () => (marketEvents = []),
    () => (highImpact = highImpact.slice(0, 2)),
    () => (catalysts = catalysts.slice(0, 2)),
  ];
  for (const trim of trims) {
    if (text.length <= EXTERNAL_CONTEXT_CHAR_BUDGET) break;
    trim();
    text = render();
  }
  return text;
}

const EXTERNAL_CONTEXT_RULES = [
  "- The 'External market context' section is SECONDARY evidence, and the ONLY sanctioned source of news/events/market-wide data. Use it to frame and qualify the technical read; it never replaces the trader's selected objective and never overrides a technical invalidation. If price breaks the invalidation level, the setup is invalid no matter how supportive the external backdrop looks.",
  "- Structure your use of it around its two sub-headings: items under 'What might explain the current move?' may only be cited as PLAUSIBLE explanations, with uncertainty stated; items under 'What matters next' are what the trader should watch, framed against the objective's horizon.",
  "- Only dated items with a listed source there are confirmed facts. Anything you infer from them is a 'plausible contributor' — label it as such. NEVER claim an event caused a price move just because it happened near it in time: write 'coincides with' or 'plausibly related to', never 'because of' or 'driven by'.",
  "- A scheduled unlock whose size/% of supply is not given is a scheduling fact only — never infer bearish (or any directional) impact from its existence; only quantified supply data supports an impact read.",
  "- Use the market backdrop and relative-strength numbers to state whether the current move looks market-wide (tracking BTC, high correlation) or asset-specific (relative strength diverging) — cite the actual numbers.",
  "- Items marked (STALE, as of ...) may be out of date; if you lean on one, say so and flag its age.",
  "- If external context is missing or thin, proceed on the technical data alone and say so.",
];

/**
 * Build the system prompt: the analyst persona plus a full data dump of the
 * current signal. `detailed` (from the panel's reasoning toggle) asks for a
 * slightly deeper read while keeping the memo tight.
 */
export function buildAnalystSystem(
  symbol: string,
  timeframe: TokenTimeframe,
  evaluation: SignalEvaluation,
  /** Accepts a plain `IntentAssessment` or the post-hysteresis `DisplayIntentAssessment` — `hold` is read off it when present. */
  assessment: (IntentAssessment & { hold?: VerdictHoldInfo }) | null,
  detailed: boolean,
  structure: ChartStructure | null = null,
  externalContext: ExternalContext | null = null,
): string {
  // Rendered up front so the rules list below can include the external-context
  // rules exactly when the section itself will appear.
  const externalBlock = externalContext ? externalContextBlock(externalContext) : null;
  const parts = [
    `You are the AI analyst inside a crypto trading dashboard, acting as a SECOND analyst reviewing the engine's work on ${symbol}/USDT (${timeframe}).`,
    "",
    "You are given two things: (1) the engine's plan and its check components, and (2) the chart structure actually drawn on the chart — support/resistance trend-line levels, demand/supply zones, and volume. Your job is to cross-check one against the other.",
    "",
    "Rules:",
    "- Use ONLY the data provided below. You have no live market feed; never invent prices, levels, zones, swing points, or news. If something isn't in the data, say you don't have it rather than guessing.",
    "- Cross-check the plan against the chart structure and call out conflicts explicitly: e.g. a supply zone between entry and target capping upside, a demand zone or S/R level sitting on the stop, resistance just above entry, or volume that doesn't support the move — and say how each changes your read.",
    "- You MAY disagree with the engine's verdict when the structure warrants it. Be specific about why, citing the actual levels and zone ranges.",
    "- The 'Engine evaluation' section above is always this instant's raw read. The objective's 'Status' line (under Trader's active objective) tells you whether that objective's Verdict/Summary is HELD (a standing call from earlier that hasn't been released yet) or fresh. If HELD, the checklist/bias beneath it are still live and may already point a different direction than the held call — that's the setup drifting since adoption, not the engine contradicting itself. Explain it in those terms instead of reporting it as an unexplained conflict.",
    ...(assessment && assessment.definition.executionTimeframe !== timeframe
      ? [
          `- Timeframe mismatch: 'Engine evaluation' above is the ${timeframe} chart (the timeframe currently on screen), but the '${assessment.definition.label}' objective triggers off ${assessment.definition.executionTimeframe}, not ${timeframe}. They are two different reads of two different candles — don't treat 'Engine evaluation' as if it were the objective's own trigger data. Lean on 'Trader's active objective' for the ${assessment.definition.label} call itself, and use 'Engine evaluation' only for what the ${timeframe} chart separately shows.`,
        ]
      : []),
    ...(externalBlock ? EXTERNAL_CONTEXT_RULES : []),
    "- Be direct. Reference concrete numbers (entry, stop, targets, R multiples, zone ranges, S/R levels, volume vs average).",
    detailed
      ? "- Give a thorough read of the evidence, but stay under ~250 words."
      : "- Keep it tight — under ~180 words.",
    "- Format with Markdown: `###` headings, `-` bullets, and `**bold**` for key levels. No tables.",
    "",
    `## Engine evaluation (${timeframe})${
      assessment && assessment.definition.executionTimeframe !== timeframe
        ? ` — the chart on screen, NOT the ${assessment.definition.label} objective's own ${assessment.definition.executionTimeframe} trigger timeframe (see below)`
        : ""
    }`,
    evaluationBlock(evaluation),
  ];
  if (structure) {
    parts.push("", "## Chart structure (drawn on the chart)", chartStructureBlock(structure));
  }
  if (assessment) {
    parts.push(
      "",
      "## Trader's active objective",
      assessmentBlock(assessment, assessment.hold ?? null),
    );
  }
  if (externalBlock) {
    parts.push("", "## External market context (secondary evidence — see rules)", externalBlock);
  }
  return parts.join("\n");
}
