// The grounding corpus for an AI Desk Review: a flat, ID-addressed list of the
// deterministic facts the engine produced for one symbol/timeframe. The LLM
// reviewer may cite ONLY these IDs and use ONLY these numbers — the pack is the
// closed world its claims are validated against (see `desk-review.ts`). It is
// mined from the same formatters the analyst prompt uses (imported from
// `analyst-context.ts`) so the two reads never diverge. Pure + client-safe.

import {
  breadthLine,
  chartStructureBlock,
  econCalendarLine,
  equalLevelsText,
  eventLine,
  liquidityText,
  num,
  prioritizeContextEvents,
  relativeLine,
  sweepsText,
  structureLine,
  upcomingLine,
  ECON_CALENDAR_MAX_ITEMS,
  type ChartStructure,
  type EconCalendarItem,
  type VerdictHoldInfo,
} from "./analyst-context";
import type { ExternalContext } from "@/lib/engine/external-context";
import type { IntentAssessment } from "@/lib/engine/intent";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";

export interface EvidenceItem {
  id: string;
  topic:
    | "structure"
    | "liquidity"
    | "zones"
    | "risk-plan"
    | "objective"
    | "history"
    | "external"
    | "econ"
    | "chart";
  text: string;
  /** Every numeric value appearing in `text` — the allowed set for claim audits. */
  numbers: number[];
}

export interface EvidencePack {
  version: 1;
  symbol: string;
  timeframe: string;
  builtAt: string;
  items: EvidenceItem[];
}

/** Every numeric token in a string — used both to stamp items and to audit claims. */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?/g);
  if (!matches) return [];
  return matches.map(Number).filter((n) => Number.isFinite(n));
}

/** Drop a leading markdown bullet/indent so a reused formatter line stands alone. */
function stripBullet(line: string): string {
  return line.replace(/^\s*-\s*/, "").trim();
}

/**
 * Build the evidence pack from one engine evaluation and its surrounding
 * context. Each item is one fact-cluster (one to two sentences), reusing the
 * analyst-prompt formatters so figures match. IDs are prefix-numbered per
 * topic: S* structure, L* liquidity, Z* zones, R* risk-plan, O* objective,
 * H* history, X* external, M* economic calendar, C* chart structure.
 */
export function buildEvidencePack(input: {
  symbol: string;
  timeframe: TokenTimeframe;
  evaluation: SignalEvaluation;
  assessment: (IntentAssessment & { hold?: VerdictHoldInfo }) | null;
  chartStructure: ChartStructure | null;
  externalContext: ExternalContext | null;
  /** Next-7-days, high+medium impact — same shape `buildAnalystSystem` takes. */
  econCalendar?: readonly EconCalendarItem[] | null;
}): EvidencePack {
  const {
    symbol,
    timeframe,
    evaluation: e,
    assessment: a,
    chartStructure,
    externalContext,
    econCalendar,
  } = input;
  const items: EvidenceItem[] = [];

  // Per-topic counters so IDs stay stable and unique.
  const counters: Record<EvidenceItem["topic"], number> = {
    structure: 0,
    liquidity: 0,
    zones: 0,
    "risk-plan": 0,
    objective: 0,
    history: 0,
    external: 0,
    econ: 0,
    chart: 0,
  };
  const prefix: Record<EvidenceItem["topic"], string> = {
    structure: "S",
    liquidity: "L",
    zones: "Z",
    "risk-plan": "R",
    objective: "O",
    history: "H",
    external: "X",
    econ: "M",
    chart: "C",
  };
  const push = (topic: EvidenceItem["topic"], text: string): void => {
    counters[topic] += 1;
    items.push({
      id: `${prefix[topic]}${counters[topic]}`,
      topic,
      text,
      numbers: extractNumbers(text),
    });
  };

  // ── Structure ──
  push("structure", `Market structure — ${structureLine(e.structure)}.`);
  if (e.structure.equalHighs.length || e.structure.equalLows.length) {
    push(
      "structure",
      `Equal levels (resting stop liquidity): equal highs ${equalLevelsText(e.structure.equalHighs)}; equal lows ${equalLevelsText(e.structure.equalLows)}.`,
    );
  }

  // ── Liquidity ──
  const liq = liquidityText(e.liquidity, e.liquiditySweeps);
  if (liq !== "none intact") {
    push(
      "liquidity",
      `Intact liquidity pools (untapped stop clusters price is drawn toward): ${liq}.`,
    );
  }
  const sweeps = sweepsText(e.liquiditySweeps);
  if (sweeps !== "none") {
    push(
      "liquidity",
      `Liquidity sweeps (stop hunts — wick through, close back inside): ${sweeps}.`,
    );
  }

  // ── Zones (as drawn on the chart) ──
  if (chartStructure) {
    for (const z of chartStructure.zones) {
      push(
        "zones",
        `${z.kind === "demand" ? "Demand" : "Supply"} zone ${num(z.priceLow)}–${num(z.priceHigh)} (${z.freshness}).`,
      );
    }
  }

  // ── Risk plan ──
  const r = e.risk;
  push(
    "risk-plan",
    `Engine risk plan (${r.direction}): entry zone ${num(r.entryLow)}–${num(r.entryHigh)}, stop ${num(r.stop)}, target 1 ${num(r.target1)}, target 2 ${num(r.target2)}, invalidation ${num(r.invalidation)}.`,
  );
  push(
    "risk-plan",
    `Reward/risk to target 1 ${num(r.rewardRisk1)}R, to target 2 ${num(r.rewardRisk2)}R; sizing ${num(r.positionSize)} units, max loss $${num(r.maxDollarLoss)}.`,
  );

  // ── Objective (trader's active assessment) ──
  if (a) {
    const ct = a.isCounterTrend ? " (counter-trend, reduced size)" : "";
    push(
      "objective",
      `Objective ${a.definition.label} (${a.definition.contextTimeframe} context / ${a.definition.executionTimeframe} trigger): verdict ${a.verdict} — ${a.headline}. Direction ${a.direction}${ct}, confidence ${a.confidence}/100. ${a.summary}`,
    );
    for (const c of a.checklist) {
      push("objective", `Checklist [${c.done ? "done" : "not yet"}] ${c.label}: ${c.detail}`);
    }
    for (const t of a.triggers) {
      push("objective", `What changes this: ${t}`);
    }
  }

  // ── History (backtest) ──
  push(
    "history",
    `Backtest (in-sample replay on this chart's own history, NOT forward-tested${e.backtest.lowSample ? "; also low sample — treat with caution" : ""}): ${e.backtest.totalTrades} trades, ${num(e.backtest.winRate)}% win rate, expectancy ${num(e.backtest.expectancy)}R.`,
  );

  // ── External market context (secondary evidence, priority-ordered) ──
  if (externalContext) {
    const x = externalContext;
    if (x.breadth) push("external", stripBullet(breadthLine(x.breadth)));
    if (x.relative) push("external", stripBullet(relativeLine(x.symbol, x.relative)));
    // Macro/ticker-tagged items pushed first within each bucket so the pack's
    // top-3 "external" trim (see `renderEvidencePack`) keeps them over
    // plain-recency items — same reorder `externalContextBlock` applies.
    for (const c of prioritizeContextEvents(x.recentCatalysts ?? [], [x.symbol]))
      push(
        "external",
        `Recent catalyst (≤48h, plausible contributor, not established cause): ${stripBullet(eventLine(c))}`,
      );
    for (const h of prioritizeContextEvents(x.recentHighImpact ?? [], [x.symbol]))
      push("external", `High-impact context (≤7d): ${stripBullet(eventLine(h))}`);
    for (const u of x.upcoming ?? [])
      push("external", `Upcoming catalyst for ${x.symbol}: ${stripBullet(upcomingLine(u))}`);
    for (const me of x.marketEvents ?? [])
      push("external", `Market-wide upcoming event: ${stripBullet(upcomingLine(me))}`);
  }

  // ── Upcoming economic calendar (market-wide scheduling facts) ──
  if (econCalendar && econCalendar.length) {
    const sorted = [...econCalendar].sort(
      (a1, b1) => Date.parse(a1.occursAt) - Date.parse(b1.occursAt),
    );
    for (const ev of sorted.slice(0, ECON_CALENDAR_MAX_ITEMS)) {
      push(
        "econ",
        `Economic calendar (scheduling fact, not a signal): ${stripBullet(econCalendarLine(ev))}`,
      );
    }
  }

  // ── Chart structure (support/resistance + volume) ──
  if (chartStructure) {
    const block = chartStructureBlock(chartStructure);
    push(
      "chart",
      `Chart trend lines — support ${chartStructure.support !== null ? num(chartStructure.support) : "none detected"}, resistance ${chartStructure.resistance !== null ? num(chartStructure.resistance) : "none detected"}.`,
    );
    // Volume line, mined from the shared block so wording matches the prompt.
    const volLine = block.split("\n").find((l) => l.startsWith("- Volume:"));
    if (volLine) push("chart", stripBullet(volLine));
  }

  return {
    version: 1,
    symbol,
    timeframe,
    builtAt: new Date().toISOString(),
    items,
  };
}

/** Total character budget for the rendered pack — the LLM request's hard cap. */
export const EVIDENCE_PACK_CHAR_BUDGET = 6000;

function limitTopic(
  items: EvidenceItem[],
  topic: EvidenceItem["topic"],
  keep: number,
): EvidenceItem[] {
  let seen = 0;
  return items.filter((it) => {
    if (it.topic !== topic) return true;
    seen += 1;
    return seen <= keep;
  });
}

function renderItems(pack: EvidencePack, items: EvidenceItem[]): string {
  const header = `## Evidence pack — ${pack.symbol} ${pack.timeframe} (deterministic engine facts; cite by [ID])`;
  return [header, ...items.map((it) => `- [${it.id}] ${it.text}`)].join("\n");
}

/**
 * Render the pack to a markdown section under a 6000-char budget. When over,
 * trim in priority order: external beyond top 3, economic calendar beyond top
 * 5, liquidity beyond top 4, zones beyond top 4, then external entirely.
 * Risk-plan, objective, and history items are never trimmed — they are the
 * review's spine.
 */
export function renderEvidencePack(pack: EvidencePack): string {
  let current = pack.items;
  let text = renderItems(pack, current);
  const steps: Array<() => EvidenceItem[]> = [
    () => limitTopic(current, "external", 3),
    () => limitTopic(current, "econ", 5),
    () => limitTopic(current, "liquidity", 4),
    () => limitTopic(current, "zones", 4),
    () => current.filter((it) => it.topic !== "external"),
  ];
  for (const step of steps) {
    if (text.length <= EVIDENCE_PACK_CHAR_BUDGET) break;
    current = step();
    text = renderItems(pack, current);
  }
  return text;
}
