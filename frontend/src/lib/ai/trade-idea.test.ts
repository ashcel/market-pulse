import { describe, expect, it } from "vitest";

import {
  OUTCOME_PERMISSIVENESS,
  buildIntentParsePrompt,
  computeDeskAnchor,
  mapHorizonToIntent,
  parseIntentParseResponse,
  parseTradeIdeaFast,
  type TradeIdea,
} from "./trade-idea";
import { INTENTS, type IntentAssessment, type IntentVerdict } from "@/lib/engine/intent";
import type { TradeDirection } from "@/lib/engine/quant";

describe("parseTradeIdeaFast", () => {
  it("parses the canonical sub-15m scalp utterance", () => {
    const idea = parseTradeIdeaFast("I want to short DEXE for the next 5-15 minutes");
    expect(idea.direction).toBe("short");
    expect(idea.symbol).toBe("DEXE");
    expect(idea.horizonMinutes).toBe(15);
    expect(idea.intent).toBe("scalp");
    expect(idea.horizonNote).not.toBeNull();
  });

  it("maps long keywords and 'this week' to a swing", () => {
    const idea = parseTradeIdeaFast("thinking of going long on ETH this week, entry 3200");
    expect(idea.direction).toBe("long");
    expect(idea.symbol).toBe("ETH");
    expect(idea.horizonMinutes).toBe(7200);
    expect(idea.intent).toBe("swing");
    expect(idea.entry).toBe(3200);
    expect(idea.stop).toBeUndefined();
  });

  it("parses sl/tp and a 'few hours' horizon", () => {
    const idea = parseTradeIdeaFast("short SOL, sl 138, tp 152, few hours");
    expect(idea.direction).toBe("short");
    expect(idea.symbol).toBe("SOL");
    expect(idea.stop).toBe(138);
    expect(idea.target).toBe(152);
    expect(idea.horizonMinutes).toBe(180);
    expect(idea.intent).toBe("intraday");
    expect(idea.horizonNote).toBeNull();
  });

  it("uses $TICKER over bare uppercase and excludes stopwords", () => {
    const idea = parseTradeIdeaFast("buy $link, target it to the USDT pair");
    expect(idea.symbol).toBe("LINK");
    expect(idea.direction).toBe("long");
  });

  it("leaves unknown pieces null rather than guessing", () => {
    const idea = parseTradeIdeaFast("should I buy BTC?");
    expect(idea.symbol).toBe("BTC");
    expect(idea.direction).toBe("long");
    expect(idea.horizonMinutes).toBeNull();
    expect(idea.intent).toBeNull();
    expect(idea.horizonNote).toBeNull();
    expect(idea.entry).toBeUndefined();
  });

  it("takes the first-stated side when both directions appear", () => {
    expect(parseTradeIdeaFast("short here, don't buy the dip").direction).toBe("short");
    expect(parseTradeIdeaFast("buy now, never short this").direction).toBe("long");
  });

  it("keeps the original text verbatim", () => {
    const text = "  Long   BTC  ";
    expect(parseTradeIdeaFast(text).rawText).toBe(text);
  });
});

describe("mapHorizonToIntent boundaries", () => {
  it("returns nulls for a null horizon", () => {
    expect(mapHorizonToIntent(null)).toEqual({ intent: null, note: null });
  });

  it("flags at-or-sub-granularity horizons (≤15m) with a note", () => {
    for (const m of [1, 14, 15]) {
      const r = mapHorizonToIntent(m);
      expect(r.intent).toBe("scalp");
      expect(r.note).not.toBeNull();
    }
  });

  it("walks the ladder boundaries without a note above 15m", () => {
    expect(mapHorizonToIntent(16)).toEqual({ intent: "scalp", note: null });
    expect(mapHorizonToIntent(120)).toEqual({ intent: "scalp", note: null });
    expect(mapHorizonToIntent(121).intent).toBe("intraday");
    expect(mapHorizonToIntent(1440).intent).toBe("intraday");
    expect(mapHorizonToIntent(1441).intent).toBe("swing");
    expect(mapHorizonToIntent(10080).intent).toBe("swing");
    expect(mapHorizonToIntent(10081).intent).toBe("position");
  });
});

// ── Anchor matrix ────────────────────────────────────────────────────────────

function assess(
  verdict: IntentVerdict,
  direction: TradeDirection,
  intent: "scalp" | "intraday" | "swing" | "position" = "scalp",
): IntentAssessment {
  const definition = INTENTS.find((d) => d.intent === intent)!;
  return { verdict, direction, definition } as unknown as IntentAssessment;
}

function idea(partial: Partial<TradeIdea> = {}): TradeIdea {
  return {
    rawText: "",
    symbol: "BTC",
    direction: "long",
    horizonMinutes: 60,
    intent: "scalp",
    horizonNote: null,
    ...partial,
  };
}

describe("computeDeskAnchor matrix", () => {
  it("no assessment → forced no-evidence naming the gap", () => {
    const a = computeDeskAnchor(idea(), null);
    expect(a.maxOutcome).toBe("no-evidence");
    expect(a.forced).toBe(true);
    expect(a.reasons.join(" ")).toMatch(/no objective assessment/i);
  });

  it("missing symbol or direction → forced no-evidence", () => {
    expect(computeDeskAnchor(idea({ symbol: null }), assess("favored", "long")).maxOutcome).toBe(
      "no-evidence",
    );
    const noDir = computeDeskAnchor(idea({ direction: null }), assess("favored", "long"));
    expect(noDir.maxOutcome).toBe("no-evidence");
    expect(noDir.forced).toBe(true);
    expect(noDir.reasons.join(" ")).toMatch(/direction/i);
  });

  it("favored + matching direction → approve, not forced", () => {
    const a = computeDeskAnchor(idea({ direction: "long" }), assess("favored", "long"));
    expect(a.maxOutcome).toBe("approve");
    expect(a.forced).toBe(false);
  });

  it("favored + opposite direction → forced reject", () => {
    const a = computeDeskAnchor(idea({ direction: "short" }), assess("favored", "long"));
    expect(a.maxOutcome).toBe("reject");
    expect(a.forced).toBe(true);
    expect(a.reasons.join(" ")).toMatch(/opposite/i);
  });

  it("caution + match → conditional; caution + opposite → forced reject", () => {
    const match = computeDeskAnchor(idea({ direction: "long" }), assess("caution", "long"));
    expect(match.maxOutcome).toBe("conditional");
    expect(match.forced).toBe(false);
    const opp = computeDeskAnchor(idea({ direction: "short" }), assess("caution", "long"));
    expect(opp.maxOutcome).toBe("reject");
    expect(opp.forced).toBe(true);
  });

  it("wait → conditional on match, forced reject when opposite", () => {
    const match = computeDeskAnchor(idea({ direction: "long" }), assess("wait", "long"));
    expect(match.maxOutcome).toBe("conditional");
    expect(match.forced).toBe(false);
    const opp = computeDeskAnchor(idea({ direction: "short" }), assess("wait", "long"));
    expect(opp.maxOutcome).toBe("reject");
    expect(opp.forced).toBe(true);
  });

  it("avoid → forced reject regardless of direction", () => {
    const a = computeDeskAnchor(idea({ direction: "long" }), assess("avoid", "none"));
    expect(a.maxOutcome).toBe("reject");
    expect(a.forced).toBe(true);
  });

  it("caps an approvable idea to conditional when the horizon is ≤15m", () => {
    const a = computeDeskAnchor(
      idea({ direction: "long", horizonMinutes: 10 }),
      assess("favored", "long"),
    );
    expect(a.maxOutcome).toBe("conditional");
    expect(a.forced).toBe(false);
    expect(a.reasons.join(" ")).toMatch(/finer than the engine's 15M/i);
  });

  it("cap never raises a reject", () => {
    const a = computeDeskAnchor(
      idea({ direction: "short", horizonMinutes: 5 }),
      assess("favored", "long"),
    );
    expect(a.maxOutcome).toBe("reject");
    expect(a.forced).toBe(true);
  });

  it("permissiveness order is approve > conditional > reject > floors", () => {
    expect(OUTCOME_PERMISSIVENESS.approve).toBeGreaterThan(OUTCOME_PERMISSIVENESS.conditional);
    expect(OUTCOME_PERMISSIVENESS.conditional).toBeGreaterThan(OUTCOME_PERMISSIVENESS.reject);
    expect(OUTCOME_PERMISSIVENESS.reject).toBeGreaterThan(OUTCOME_PERMISSIVENESS["out-of-scope"]);
    expect(OUTCOME_PERMISSIVENESS["out-of-scope"]).toBe(OUTCOME_PERMISSIVENESS["no-evidence"]);
  });
});

// ── LLM fallback parser ──────────────────────────────────────────────────────

describe("intent-parse LLM fallback", () => {
  it("builds a prompt with schema and few-shot examples", () => {
    const prompt = buildIntentParsePrompt("hmm not sure");
    expect(prompt).toContain('"horizonMinutes"');
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain("DEXE");
    expect(prompt).toContain(JSON.stringify("hmm not sure"));
  });

  it("parses a clean JSON response and derives intent from the horizon", () => {
    const idea = parseIntentParseResponse(
      '{"symbol":"sol","direction":"long","horizonMinutes":180,"entry":142,"stop":138,"target":null}',
      "orig text",
    );
    expect(idea).not.toBeNull();
    expect(idea!.symbol).toBe("SOL");
    expect(idea!.direction).toBe("long");
    expect(idea!.horizonMinutes).toBe(180);
    expect(idea!.intent).toBe("intraday");
    expect(idea!.entry).toBe(142);
    expect(idea!.stop).toBe(138);
    expect(idea!.target).toBeUndefined();
    expect(idea!.rawText).toBe("orig text");
  });

  it("tolerates code fences and fills null intent for a null horizon", () => {
    const idea = parseIntentParseResponse(
      '```json\n{"symbol":"BTC","direction":null,"horizonMinutes":null,"entry":null,"stop":null,"target":null}\n```',
      "x",
    );
    expect(idea).not.toBeNull();
    expect(idea!.direction).toBeNull();
    expect(idea!.intent).toBeNull();
    expect(idea!.horizonNote).toBeNull();
  });

  it("returns null when no JSON object is present", () => {
    expect(parseIntentParseResponse("sorry, I cannot help", "x")).toBeNull();
  });
});
