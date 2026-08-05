import { describe, expect, it } from "vitest";

import {
  calendarItems,
  filterAttention,
  liquidityItems,
  newsItems,
  rankAttention,
  setupItems,
  spikeItems,
  tokenEventItems,
  type AttentionItem,
} from "./attention";
import type { MarketOpportunity, SpikeHit } from "./discovery";
import type { IntentAssessment } from "./intent";
import type { NewsItem } from "@/lib/types";

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);

function item(over: Partial<AttentionItem>): AttentionItem {
  return {
    id: "x",
    kind: "news",
    kindLabel: "News",
    priority: "low",
    symbol: null,
    title: "t",
    subtitle: "s",
    score: null,
    scoreLabel: null,
    reasons: [],
    stats: [],
    at: NOW,
    upcoming: false,
    symbolLink: null,
    url: null,
    ...over,
  };
}

function assessment(over: Partial<IntentAssessment> = {}): IntentAssessment {
  return {
    intent: "intraday",
    definition: { label: "Intraday" },
    verdict: "favored",
    direction: "long",
    isCounterTrend: false,
    sizeMultiplier: 1,
    headline: "Pullback continuation",
    summary: "",
    checklist: [],
    triggers: ["H1 close above 174", "Loses the setup below 168", "Volume must confirm"],
    confidence: 82,
    contextBias: "long",
    executionBias: "long",
    context: {} as IntentAssessment["context"],
    execution: {} as IntentAssessment["execution"],
    plan: {
      direction: "long",
      entry: 100,
      entryLow: 98,
      entryHigh: 101,
      stop: 95,
      target1: 110,
      target2: 120,
      riskPerUnit: 5,
      rewardPerUnit1: 10,
      rewardPerUnit2: 20,
      rewardRisk1: 1.9,
      rewardRisk2: 4,
      maxDollarRisk: 100,
      positionSize: 20,
    } as IntentAssessment["plan"],
    anticipatoryPlan: null,
    location: null,
    ...over,
  } as IntentAssessment;
}

describe("rankAttention", () => {
  it("puts high priority first regardless of time", () => {
    const ranked = rankAttention(
      [
        item({ id: "old-high", priority: "high", at: NOW - 6 * 3_600_000 }),
        item({ id: "new-low", priority: "low", at: NOW }),
      ],
      NOW,
    );
    expect(ranked.map((i) => i.id)).toEqual(["old-high", "new-low"]);
  });

  it("breaks priority ties by closeness to now, past or future alike", () => {
    const ranked = rankAttention(
      [
        item({ id: "far-future", priority: "high", at: NOW + 48 * 3_600_000 }),
        item({ id: "near-past", priority: "high", at: NOW - 10 * 60_000 }),
        item({ id: "near-future", priority: "high", at: NOW + 20 * 60_000 }),
      ],
      NOW,
    );
    expect(ranked.map((i) => i.id)).toEqual(["near-past", "near-future", "far-future"]);
  });

  it("is a pure sort — the input array is not mutated", () => {
    const input = [item({ id: "a", priority: "low" }), item({ id: "b", priority: "high" })];
    rankAttention(input, NOW);
    expect(input.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("setupItems", () => {
  it("maps a favored verdict to a high-priority card with entry zone and R:R", () => {
    const [card] = setupItems([{ ticker: "SOL", assessment: assessment(), price: 100 }], NOW);
    expect(card.kind).toBe("setup");
    expect(card.priority).toBe("high");
    expect(card.score).toBe(82);
    expect(card.scoreLabel).toBe("Confidence");
    expect(card.symbolLink).toBe("SOL");
    expect(card.stats.map((s) => s.label)).toEqual(["Entry Zone", "R:R"]);
    expect(card.stats[1].value).toBe("1.9");
  });

  it("demotes non-favored verdicts and never claims more than three triggers", () => {
    const [card] = setupItems(
      [{ ticker: "ETH", assessment: assessment({ verdict: "wait", plan: null }), price: 2000 }],
      NOW,
    );
    expect(card.priority).toBe("low");
    expect(card.reasons).toHaveLength(3);
    expect(card.stats[0].label).toBe("Price");
  });
});

describe("spikeItems", () => {
  const hit: SpikeHit = {
    ticker: "WIF",
    name: "dogwifhat",
    price: 1.5,
    tracked: false,
    spike: {
      direction: "up",
      time: 0,
      barsAgo: 0,
      rangeMult: 3.2,
      volumeMult: 4.1,
      rejectionFraction: 0.6,
      rangePct: 7.5,
      reason: "Sharp up-spike rejected on 4.1× volume",
    },
  };

  it("flags the freshest bar as high priority and backdates older ones", () => {
    const [fresh] = spikeItems([hit], NOW);
    expect(fresh.priority).toBe("high");
    expect(fresh.at).toBe(NOW);

    const [stale] = spikeItems([{ ...hit, spike: { ...hit.spike, barsAgo: 4 } }], NOW);
    expect(stale.priority).toBe("medium");
    expect(stale.at).toBe(NOW - 4 * 15 * 60_000);
  });

  it("never carries a score — the discovery plane has no confidence to report", () => {
    const [card] = spikeItems([hit], NOW);
    expect(card.score).toBeNull();
    expect(card.subtitle).toMatch(/not a signal/i);
  });
});

describe("liquidityItems", () => {
  const row: MarketOpportunity = {
    ticker: "SOL",
    name: "Solana",
    price: 184.52,
    change24h: 2.4,
    rangePercent24h: 4.21,
    quoteVolume24h: 1_200_000_000,
    trades24h: 900_000,
    score: 78.4,
    volatilityPercentile: 90,
    liquidityPercentile: 95,
    activityPercentile: 88,
    tracked: true,
    reason: "Wide range on deep liquidity",
  };

  it("carries the scan score under an honest label", () => {
    const [card] = liquidityItems([row], NOW);
    expect(card.score).toBe(78);
    expect(card.scoreLabel).toBe("Scan score");
    expect(card.priority).toBe("high");
    expect(card.stats[1].value).toBe("$1.20B");
  });

  it("demotes mid-scoring rows", () => {
    const [card] = liquidityItems([{ ...row, score: 51 }], NOW);
    expect(card.priority).toBe("medium");
  });
});

describe("newsItems", () => {
  const news: NewsItem = {
    id: "n1",
    headline: "Bitcoin breaks $63K",
    impact: "high",
    direction: "bullish",
    assets: ["BTC", "ETH"],
    minutesAgo: 30,
    source: "CoinDesk",
  };

  it("backdates by minutesAgo and links the first tagged asset", () => {
    const [card] = newsItems([news], NOW);
    expect(card.at).toBe(NOW - 30 * 60_000);
    expect(card.upcoming).toBe(false);
    expect(card.symbolLink).toBe("BTC");
    expect(card.priority).toBe("high");
  });
});

describe("calendarItems", () => {
  it("marks calendar rows upcoming and keeps the forecast when there is one", () => {
    const [card] = calendarItems([
      {
        id: "e1",
        title: "FOMC Meeting",
        country: "USD",
        impact: "high",
        forecast: "5.25%",
        previous: "5.00%",
        occursAt: new Date(NOW + 3 * 3_600_000).toISOString(),
      },
    ]);
    expect(card.upcoming).toBe(true);
    expect(card.at).toBe(NOW + 3 * 3_600_000);
    expect(card.reasons.some((r) => r.includes("5.25%"))).toBe(true);
    expect(card.symbol).toBeNull();
  });
});

describe("tokenEventItems", () => {
  const base = {
    id: "t1",
    symbol: "TIA",
    kind: "unlock",
    severity: "warning" as const,
    title: "TIA unlock",
    body: "$12.4M (1.95% of supply)",
    source: "defillama",
    url: null,
    publishedAt: new Date(NOW + 18 * 3_600_000).toISOString(),
  };

  it("treats a future-dated unlock as a countdown", () => {
    const [card] = tokenEventItems([base], NOW);
    expect(card.kind).toBe("unlock");
    expect(card.upcoming).toBe(true);
    expect(card.priority).toBe("medium");
  });

  it("treats an already-published event as history", () => {
    const [card] = tokenEventItems(
      [{ ...base, publishedAt: new Date(NOW - 3_600_000).toISOString() }],
      NOW,
    );
    expect(card.upcoming).toBe(false);
  });

  it("routes non-unlock kinds to the news bucket", () => {
    const [card] = tokenEventItems([{ ...base, kind: "security", severity: "critical" }], NOW);
    expect(card.kind).toBe("news");
    expect(card.priority).toBe("high");
  });
});

describe("filterAttention", () => {
  it("passes everything through on 'all' and narrows to one kind otherwise", () => {
    const items = [item({ id: "a", kind: "setup" }), item({ id: "b", kind: "unlock" })];
    expect(filterAttention(items, "all")).toHaveLength(2);
    expect(filterAttention(items, "unlock").map((i) => i.id)).toEqual(["b"]);
  });
});
