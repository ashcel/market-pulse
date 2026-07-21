import { describe, expect, it } from "vitest";

import {
  EVIDENCE_PACK_CHAR_BUDGET,
  buildEvidencePack,
  extractNumbers,
  renderEvidencePack,
  type EvidenceItem,
  type EvidencePack,
} from "./evidence-pack";
import type { ChartStructure } from "./analyst-context";
import { computePivots } from "@/lib/engine/analysis";
import { generateMockCandles } from "@/lib/engine/mock-candles";
import { evaluateSignal } from "@/lib/engine/quant";
import { INTENTS, type IntentAssessment } from "@/lib/engine/intent";

const candles = generateMockCandles("BTC", "1H", 200);
const evaluation = evaluateSignal("BTC", candles, computePivots(candles));

const chartStructure: ChartStructure = {
  support: 100.5,
  resistance: 110.25,
  zones: [
    { kind: "demand", priceLow: 99, priceHigh: 101, startTime: 0, endTime: 1, freshness: "fresh" },
    {
      kind: "supply",
      priceLow: 111,
      priceHigh: 113,
      startTime: 2,
      endTime: 3,
      freshness: "tested",
    },
  ],
  latestVolume: 1200,
  avgVolume20: 1000,
};

const assessment = {
  definition: INTENTS[0],
  verdict: "favored",
  headline: "Long scalp favored",
  direction: "long",
  isCounterTrend: false,
  confidence: 72,
  summary: "The 1H trend and 15M trigger agree.",
  checklist: [
    { label: "1H trend agrees", detail: "The 1H chart leans long.", done: true },
    { label: "Momentum", detail: "RSI rising above 55.", done: true },
  ],
  triggers: ["A 15M close below 98 invalidates the long idea."],
} as unknown as IntentAssessment;

describe("extractNumbers", () => {
  it("pulls every numeric token including decimals and negatives", () => {
    expect(extractNumbers("entry 12.5, stop -3, target 14")).toEqual([12.5, -3, 14]);
    expect(extractNumbers("no numbers here")).toEqual([]);
  });
});

describe("buildEvidencePack", () => {
  const pack = buildEvidencePack({
    symbol: "BTC",
    timeframe: "15M",
    evaluation,
    assessment,
    chartStructure,
    externalContext: null,
  });

  it("assigns unique, topic-prefixed IDs", () => {
    const ids = pack.items.map((it) => it.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("R1");
    expect(ids).toContain("H1");
    expect(pack.items.some((it) => it.topic === "objective" && it.id.startsWith("O"))).toBe(true);
    expect(pack.items.some((it) => it.topic === "zones" && it.id.startsWith("Z"))).toBe(true);
  });

  it("stamps each item with the numbers appearing in its text", () => {
    const risk = pack.items.find((it) => it.id === "R1")!;
    expect(risk.numbers.length).toBeGreaterThan(0);
    expect(risk.numbers).toEqual(extractNumbers(risk.text));
    const zone = pack.items.find((it) => it.topic === "zones")!;
    expect(zone.numbers).toContain(99);
  });

  it("includes the in-sample backtest caveat in the history item", () => {
    const history = pack.items.find((it) => it.topic === "history")!;
    expect(history.text).toMatch(/in-sample replay/i);
    expect(history.text).toMatch(/NOT forward-tested/i);
  });

  it("renders objective checklist and triggers as O items", () => {
    const objective = pack.items.filter((it) => it.topic === "objective");
    expect(objective.length).toBeGreaterThanOrEqual(4); // verdict + 2 checklist + 1 trigger
    expect(objective.some((it) => it.text.includes("Long scalp favored"))).toBe(true);
    expect(objective.some((it) => it.text.includes("invalidates"))).toBe(true);
  });
});

// ── Rendering + trim behavior ────────────────────────────────────────────────

function item(id: string, topic: EvidenceItem["topic"], text: string): EvidenceItem {
  return { id, topic, text, numbers: extractNumbers(text) };
}

function packOf(items: EvidenceItem[]): EvidencePack {
  return { version: 1, symbol: "BTC", timeframe: "15M", builtAt: "2026-07-21T00:00:00Z", items };
}

const filler = (n: number) => `context detail ${"y".repeat(240)} item ${n}`;

describe("renderEvidencePack", () => {
  it("renders a header and one bullet per item", () => {
    const text = renderEvidencePack(packOf([item("S1", "structure", "Uptrend intact.")]));
    expect(text).toContain("## Evidence pack — BTC 15M");
    expect(text).toContain("- [S1] Uptrend intact.");
  });

  it("trims external beyond the top 3 first, keeping the spine", () => {
    const externals = Array.from({ length: 30 }, (_, i) =>
      item(`X${i + 1}`, "external", filler(i + 1)),
    );
    const pack = packOf([
      item("R1", "risk-plan", "Risk plan retained."),
      item("O1", "objective", "Objective retained."),
      item("H1", "history", "History retained."),
      ...externals,
    ]);
    const text = renderEvidencePack(pack);
    expect(text.length).toBeLessThanOrEqual(EVIDENCE_PACK_CHAR_BUDGET);
    expect(text).toContain("[X3]");
    expect(text).not.toContain("[X4]");
    // Spine is never trimmed.
    expect(text).toContain("[R1]");
    expect(text).toContain("[O1]");
    expect(text).toContain("[H1]");
  });

  it("trims liquidity beyond the top 4 when external is already small", () => {
    const liq = Array.from({ length: 40 }, (_, i) => item(`L${i + 1}`, "liquidity", filler(i + 1)));
    const text = renderEvidencePack(packOf(liq));
    expect(text.length).toBeLessThanOrEqual(EVIDENCE_PACK_CHAR_BUDGET);
    expect(text).toContain("[L4]");
    expect(text).not.toContain("[L5]");
  });

  it("drops external entirely as the last resort", () => {
    // 3 huge external items survive the 'beyond top 3' trim but still overflow;
    // the final step removes external outright, leaving only the spine.
    const externals = Array.from({ length: 3 }, (_, i) =>
      item(`X${i + 1}`, "external", `big ${"z".repeat(2500)} ${i}`),
    );
    const text = renderEvidencePack(packOf([item("R1", "risk-plan", "kept"), ...externals]));
    expect(text).toContain("[R1]");
    expect(text).not.toContain("[X1]");
  });
});
