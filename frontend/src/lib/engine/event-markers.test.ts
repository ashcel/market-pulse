import { describe, expect, it } from "vitest";

import {
  buildChartEvents,
  snapToCandle,
  toneForKind,
  whenLabel,
  type PastEventLike,
  type UpcomingEventLike,
} from "./event-markers";

const NOW = Date.parse("2026-07-18T12:00:00Z");

function past(overrides: Partial<PastEventLike> = {}): PastEventLike {
  return {
    id: "e1",
    kind: "security",
    title: "Bridge exploit drains $40M",
    source: "cointelegraph",
    url: "https://example.com/a",
    publishedAt: "2026-07-18T10:00:00Z",
    ...overrides,
  };
}

function upcoming(overrides: Partial<UpcomingEventLike> = {}): UpcomingEventLike {
  return {
    kind: "unlock",
    title: "ARB cliff unlock",
    source: "coinmarketcal",
    url: null,
    occursAt: "2026-07-21T12:00:00Z",
    ...overrides,
  };
}

describe("toneForKind", () => {
  it("maps security/delisting/regulatory/unlock to bearish", () => {
    for (const k of ["security", "delisting", "regulatory", "unlock", "Unlock"]) {
      expect(toneForKind(k)).toBe("bearish");
    }
  });
  it("maps listing/upgrade/burn to bullish", () => {
    for (const k of ["listing", "upgrade", "burn"]) expect(toneForKind(k)).toBe("bullish");
  });
  it("falls back to neutral for unknown kinds", () => {
    expect(toneForKind("fork")).toBe("neutral");
    expect(toneForKind("mystery")).toBe("neutral");
  });
});

describe("buildChartEvents", () => {
  it("normalizes both families and sorts ascending by time", () => {
    const events = buildChartEvents([past()], [upcoming()], NOW);
    expect(events.map((e) => e.when)).toEqual(["past", "upcoming"]);
    expect(events[0].timeSec).toBeLessThan(events[1].timeSec);
    expect(events[1].tone).toBe("bearish"); // unlock → red
  });

  it("drops rows with an unparseable timestamp", () => {
    const events = buildChartEvents(
      [past({ publishedAt: "not-a-date" })],
      [upcoming({ occursAt: "" })],
      NOW,
    );
    expect(events).toHaveLength(0);
  });

  it("demotes an upcoming row whose time is already past", () => {
    const events = buildChartEvents([], [upcoming({ occursAt: "2026-07-18T06:00:00Z" })], NOW);
    expect(events).toHaveLength(1);
    expect(events[0].when).toBe("past");
  });

  it("de-dupes by id, keeping the first (past over calendar echo)", () => {
    const dup = past({ id: "past:coinmarketcal:unlock:1000" });
    const events = buildChartEvents([dup, dup], [], NOW);
    expect(events).toHaveLength(1);
  });
});

describe("whenLabel", () => {
  it("renders future events with an 'in' prefix and past with 'ago'", () => {
    expect(whenLabel((NOW + 3 * 86_400_000) / 1000, NOW)).toBe("in 3d");
    expect(whenLabel((NOW - 5 * 3_600_000) / 1000, NOW)).toBe("5h ago");
    expect(whenLabel((NOW - 30 * 60_000) / 1000, NOW)).toBe("30m ago");
  });
});

describe("snapToCandle", () => {
  const times = [100, 200, 300, 400];
  it("returns the candle at or before the event", () => {
    expect(snapToCandle(times, 250)).toBe(200);
    expect(snapToCandle(times, 300)).toBe(300);
    expect(snapToCandle(times, 999)).toBe(400); // future pins to the last bar
  });
  it("returns null when the event predates all loaded bars", () => {
    expect(snapToCandle(times, 50)).toBeNull();
    expect(snapToCandle([], 100)).toBeNull();
  });
});
