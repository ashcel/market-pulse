import { describe, expect, it } from "vitest";

import { normalizeCoinMarketCalEvents, passesCredibilityGate } from "./catalyst-events";

const NOW = Date.parse("2026-07-13T12:00:00Z");
const daysAhead = (d: number) => new Date(NOW + d * 24 * 60 * 60_000).toISOString();

/** Shape-faithful CoinMarketCal /v1/events entry. */
function cmcEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "123456",
    title: { en: "SOL token unlock" },
    description: { en: "Cliff unlock for team allocation" },
    coins: [{ id: "solana", symbol: "SOL", fullname: "Solana" }],
    date_event: daysAhead(3),
    categories: [{ id: 5, name: "Token Unlock" }],
    proof: "https://coinmarketcal.com/proof/123456.png",
    source: "https://example.com/announcement",
    vote_count: 41,
    percentage: 92,
    ...overrides,
  };
}

const normalize = (events: Array<Record<string, unknown>>) =>
  normalizeCoinMarketCalEvents({ body: events }, NOW);

describe("normalizeCoinMarketCalEvents", () => {
  it("normalizes a well-formed unlock event via provider-ID mapping", () => {
    const [event] = normalize([cmcEvent()]);
    expect(event).toMatchObject({
      symbol: "SOL",
      kind: "unlock",
      title: "SOL token unlock",
      source: "coinmarketcal",
      sourceId: "123456",
      url: "https://coinmarketcal.com/proof/123456.png",
      credibility: { votes: 41, confidencePct: 92 },
      percentOfSupply: null,
      dedupKey: "coinmarketcal:123456:SOL",
    });
    expect(Date.parse(event.occursAt)).toBe(Date.parse(daysAhead(3)));
  });

  it("maps by provider coin ID, never ticker text — unmapped coins drop", () => {
    const events = normalize([
      cmcEvent({
        coins: [
          { id: "solana", symbol: "SOL" },
          { id: "some-obscure-fork", symbol: "SOL" }, // ticker collision: must not map
        ],
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].symbol).toBe("SOL");
  });

  it("fans a multi-coin event out to one row per mapped coin", () => {
    const events = normalize([
      cmcEvent({ coins: [{ id: "bitcoin" }, { id: "ethereum" }, { id: "unmapped-coin" }] }),
    ]);
    expect(events.map((e) => e.symbol).sort()).toEqual(["BTC", "ETH"]);
    // Distinct dedup keys per symbol — one coin's update can't clobber the other's.
    expect(new Set(events.map((e) => e.dedupKey)).size).toBe(2);
  });

  it("classifies categories into kinds, defaulting to other", () => {
    const kindOf = (name: string) => normalize([cmcEvent({ categories: [{ name }] })])[0]?.kind;
    expect(kindOf("Token Unlock")).toBe("unlock");
    expect(kindOf("Exchange Listing")).toBe("listing");
    expect(kindOf("Hard Fork")).toBe("fork");
    expect(kindOf("Burn Event")).toBe("burn");
    expect(kindOf("Mainnet Release")).toBe("upgrade");
    expect(kindOf("AMA Session")).toBe("other");
  });

  it("drops events that fail the credibility gate", () => {
    const noCred = cmcEvent({ proof: null, source: null, vote_count: 3, percentage: 40 });
    expect(normalize([noCred])).toHaveLength(0);
    // Each leg of the gate is individually sufficient.
    expect(passesCredibilityGate({ url: "https://x", votes: null, confidencePct: null })).toBe(
      true,
    );
    expect(passesCredibilityGate({ url: null, votes: 15, confidencePct: null })).toBe(true);
    expect(passesCredibilityGate({ url: null, votes: null, confidencePct: 80 })).toBe(true);
    expect(passesCredibilityGate({ url: null, votes: 14, confidencePct: 79 })).toBe(false);
  });

  it("drops past events but tolerates a day of timezone slack", () => {
    expect(normalize([cmcEvent({ date_event: daysAhead(-2) })])).toHaveLength(0);
    expect(normalize([cmcEvent({ date_event: daysAhead(-0.5) })])).toHaveLength(1);
  });

  it("returns [] on shape surprises instead of throwing", () => {
    expect(normalizeCoinMarketCalEvents(null, NOW)).toEqual([]);
    expect(normalizeCoinMarketCalEvents({ body: "nope" }, NOW)).toEqual([]);
    expect(normalize([{ title: null, date_event: "garbage" }])).toEqual([]);
  });
});
