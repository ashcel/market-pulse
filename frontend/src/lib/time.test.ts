import { describe, expect, it } from "vitest";

import { humanDuration, humanRelative, localDayLabel, localDateTime, localTime } from "./time";

const NOW = new Date(2026, 7, 5, 12, 0, 0).getTime(); // local noon, 5 Aug 2026

describe("humanDuration", () => {
  it("rounds to one unit and pluralises", () => {
    expect(humanDuration(30 * 60_000)).toBe("30 mins");
    expect(humanDuration(60_000)).toBe("1 min");
    expect(humanDuration(4 * 3_600_000)).toBe("4 hours");
    expect(humanDuration(3_600_000)).toBe("1 hour");
    expect(humanDuration(2 * 86_400_000)).toBe("2 days");
    expect(humanDuration(86_400_000)).toBe("1 day");
  });

  it("promotes to the next unit at the boundary", () => {
    expect(humanDuration(59 * 60_000)).toBe("59 mins");
    expect(humanDuration(90 * 60_000)).toBe("2 hours");
    expect(humanDuration(23 * 3_600_000)).toBe("23 hours");
  });

  it("is sign-agnostic and floors under a minute", () => {
    expect(humanDuration(-4 * 3_600_000)).toBe("4 hours");
    expect(humanDuration(30_000)).toBe("less than a minute");
  });
});

describe("humanRelative", () => {
  it("phrases the future with 'in' and the past with 'ago'", () => {
    expect(humanRelative(NOW + 4 * 3_600_000, NOW)).toBe("in 4 hours");
    expect(humanRelative(NOW + 30 * 60_000, NOW)).toBe("in 30 mins");
    expect(humanRelative(NOW - 30 * 60_000, NOW)).toBe("30 mins ago");
    expect(humanRelative(NOW - 2 * 86_400_000, NOW)).toBe("2 days ago");
  });

  it("collapses the last minute either side to 'now'", () => {
    expect(humanRelative(NOW + 20_000, NOW)).toBe("now");
    expect(humanRelative(NOW - 20_000, NOW)).toBe("now");
  });

  it("accepts an ISO string and rejects an unparseable one", () => {
    expect(humanRelative(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe("in 1 hour");
    expect(humanRelative("not-a-date", NOW)).toBe("—");
  });
});

describe("local formatting", () => {
  it("renders 24h local clock time", () => {
    expect(localTime(new Date(2026, 7, 5, 9, 5).getTime())).toBe("09:05");
    expect(localTime(new Date(2026, 7, 5, 21, 30).getTime())).toBe("21:30");
  });

  it("labels today and tomorrow by the local calendar day, not by elapsed hours", () => {
    expect(localDayLabel(new Date(2026, 7, 5, 23, 59).getTime(), NOW)).toBe("Today");
    expect(localDayLabel(new Date(2026, 7, 6, 0, 30).getTime(), NOW)).toBe("Tomorrow");
    expect(localDayLabel(new Date(2026, 7, 7, 12, 0).getTime(), NOW)).toMatch(/Aug 7/);
  });

  it("combines day and time", () => {
    expect(localDateTime(new Date(2026, 7, 5, 21, 0).getTime(), NOW)).toBe("Today 21:00");
  });

  it("returns a dash for an invalid input rather than 'Invalid Date'", () => {
    expect(localTime("nope")).toBe("—");
    expect(localDayLabel("nope")).toBe("—");
  });
});
