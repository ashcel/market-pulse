import { describe, expect, it } from "vitest";

import { buildDeskSystem, parseDeskReview } from "./desk-review";
import { extractNumbers, type EvidenceItem, type EvidencePack } from "./evidence-pack";
import type { DeskAnchor, TradeIdea } from "./trade-idea";

function item(id: string, topic: EvidenceItem["topic"], text: string): EvidenceItem {
  return { id, topic, text, numbers: extractNumbers(text) };
}

const pack: EvidencePack = {
  version: 1,
  symbol: "BTC",
  timeframe: "15M",
  builtAt: "2026-07-21T00:00:00Z",
  items: [
    item("S1", "structure", "Uptrend, last swing high at 105.5."),
    item("R1", "risk-plan", "Entry 100, stop 98, target 110."),
  ],
};

const idea: TradeIdea = {
  rawText: "long BTC scalp",
  symbol: "BTC",
  direction: "long",
  horizonMinutes: 60,
  intent: "scalp",
  horizonNote: null,
};

const conditionalAnchor: DeskAnchor = { maxOutcome: "conditional", forced: false, reasons: ["r"] };
const forcedReject: DeskAnchor = {
  maxOutcome: "reject",
  forced: true,
  reasons: ["engine favors the other side"],
};

const cleanJson = JSON.stringify({
  outcome: "conditional",
  thesis: "Structure supports a long toward 110.",
  challenges: [{ claim: "Resistance sits at 105.5 per S1.", citations: ["S1"] }],
  conditions: ["hold above 100"],
  invalidation: "close below 98",
  watch: ["momentum"],
  confidence: 65,
});

describe("buildDeskSystem", () => {
  it("states the deterministic ceiling and the strict-JSON contract", () => {
    const prompt = buildDeskSystem(idea, conditionalAnchor, pack);
    expect(prompt).toContain('The engine\'s deterministic ceiling for this idea is "conditional"');
    expect(prompt).toContain("NEVER exceed it");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain('"outcome"');
    expect(prompt).toContain("[S1]"); // the rendered evidence pack is embedded
    expect(prompt).toContain("conviction is NOT evidence");
  });

  it("marks a forced anchor as mandatory", () => {
    const prompt = buildDeskSystem(idea, forcedReject, pack);
    expect(prompt).toContain("FORCED");
    expect(prompt).toContain('MUST be exactly "reject"');
  });

  it("adds the economic-calendar grounding rule only when the pack carries econ items", () => {
    const withoutEcon = buildDeskSystem(idea, conditionalAnchor, pack);
    expect(withoutEcon).not.toContain("SCHEDULING FACTS only");

    const packWithEcon: EvidencePack = {
      ...pack,
      items: [...pack.items, item("M1", "econ", "FOMC rate decision, US, high impact.")],
    };
    const withEcon = buildDeskSystem(idea, conditionalAnchor, packWithEcon);
    expect(withEcon).toContain("SCHEDULING FACTS only");
    expect(withEcon).toContain('prefix "M"');
  });
});

describe("parseDeskReview enforcement", () => {
  it("passes a clean in-bounds response through unchanged", () => {
    const r = parseDeskReview(cleanJson, conditionalAnchor, pack);
    expect(r.outcome).toBe("conditional");
    expect(r.warnings).toEqual([]);
    expect(r.challenges).toHaveLength(1);
    expect(r.citedIds).toEqual(["S1"]);
    expect(r.confidence).toBe(65);
    expect(r.invalidation).toBe("close below 98");
  });

  it("tolerates code fences", () => {
    const r = parseDeskReview("```json\n" + cleanJson + "\n```", conditionalAnchor, pack);
    expect(r.outcome).toBe("conditional");
    expect(r.warnings).toEqual([]);
  });

  it("tolerates prose wrapped around the JSON", () => {
    const r = parseDeskReview(
      `Here is my review:\n${cleanJson}\nHope that helps.`,
      conditionalAnchor,
      pack,
    );
    expect(r.outcome).toBe("conditional");
    expect(r.thesis).toContain("Structure supports");
  });

  it("clamps an over-permissive outcome down to the anchor", () => {
    const raw = JSON.stringify({ ...JSON.parse(cleanJson), outcome: "approve" });
    const r = parseDeskReview(raw, conditionalAnchor, pack);
    expect(r.outcome).toBe("conditional");
    expect(r.warnings).toContain("clamped-to-anchor");
  });

  it("forces the exact outcome for a forced anchor", () => {
    const raw = JSON.stringify({ ...JSON.parse(cleanJson), outcome: "approve" });
    const r = parseDeskReview(raw, forcedReject, pack);
    expect(r.outcome).toBe("reject");
    expect(r.warnings).toContain("forced-to-anchor");
  });

  it("drops citations absent from the pack and flags fully-uncited claims", () => {
    const raw = JSON.stringify({
      ...JSON.parse(cleanJson),
      challenges: [
        { claim: "Real point.", citations: ["S1", "Z9"] },
        { claim: "Ungrounded point.", citations: ["Q7"] },
      ],
    });
    const r = parseDeskReview(raw, conditionalAnchor, pack);
    expect(r.warnings).toContain("unknown-citation:Z9");
    expect(r.warnings).toContain("unknown-citation:Q7");
    expect(r.warnings).toContain("uncited-claim");
    expect(r.challenges[0].citations).toEqual(["S1"]);
    expect(r.challenges[1].citations).toEqual([]);
    expect(r.citedIds).toEqual(["S1"]);
  });

  it("flags a numeric claim the pack cannot back", () => {
    const raw = JSON.stringify({
      ...JSON.parse(cleanJson),
      thesis: "Price is racing toward 12345.67 imminently.",
    });
    const r = parseDeskReview(raw, conditionalAnchor, pack);
    expect(r.warnings).toContain("unverified-number:12345.67");
  });

  it("nulls a confidence outside 0–100", () => {
    const raw = JSON.stringify({ ...JSON.parse(cleanJson), confidence: 150 });
    expect(parseDeskReview(raw, conditionalAnchor, pack).confidence).toBeNull();
  });

  it("invalid outcome falls back to the anchor ceiling", () => {
    const raw = JSON.stringify({ ...JSON.parse(cleanJson), outcome: "definitely-yes" });
    const r = parseDeskReview(raw, conditionalAnchor, pack);
    expect(r.outcome).toBe("conditional");
    expect(r.warnings).toContain("invalid-outcome");
  });

  it("degrades garbage to an unstructured fallback at the anchor ceiling", () => {
    const r = parseDeskReview("totally not json at all", forcedReject, pack);
    expect(r.outcome).toBe("reject");
    expect(r.warnings).toContain("unstructured-response");
    expect(r.thesis).toBe("totally not json at all");
  });

  it("salvages the thesis text from JSON truncated by a token limit", () => {
    const raw =
      '{"outcome": "conditional", "thesis": "Structure supports a long toward 110.", "challenges": [{"claim"';
    const r = parseDeskReview(raw, forcedReject, pack);
    expect(r.warnings).toContain("unstructured-response");
    expect(r.thesis).toBe("Structure supports a long toward 110.");
  });
});
