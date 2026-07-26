import { describe, expect, it } from "vitest";

import { shown, why, type MetricValue, type TradeForensics } from "@/hooks/useForensics";

import { buildTradeContextPrompt } from "./prompt";
import type { CandleContext, ReviewTrade, UserBaseline } from "./types";

function metric(value: number | null, reason: string | null, unit = "r_multiple"): MetricValue {
  return {
    available: value !== null,
    value,
    unit,
    reason,
    flags: [],
    forensics_version: "1.0.0",
  };
}

function forensicsFixture(overrides: Partial<TradeForensics> = {}): TradeForensics {
  return {
    id: "f1",
    user_id: "u1",
    binance_trade_id: "t1",
    forensics_version: "1.0.0",
    kline_interval: "1m",
    kline_candles_in_window: 5,
    boundary_inflation_bound_pct: 0.4,
    metrics: {
      mae_percent: metric(3.4, null, "percent_of_entry"),
      mae_r: metric(null, "no_stop_on_record"),
      mfe_r: metric(null, "no_stop_on_record"),
      realized_r: metric(null, "no_stop_on_record"),
      slippage_adverse_r: metric(null, "no_stop_on_record"),
      violation_depth_r: metric(null, "no_stop_on_record"),
    },
    stop_evidence: "absent",
    discipline_breach: false,
    partial_close_suspected: false,
    reentry_same_direction: null,
    reentry_after_loss: null,
    sizing_mode: null,
    sizing_n: null,
    sizing_excluded: null,
    sizing_partial_close_rows: null,
    created_at: "2026-07-26T00:00:00Z",
    ...overrides,
  };
}

describe("forensics render gate", () => {
  it("never yields a renderable R value for a trade with no evidenced stop", () => {
    const forensics = forensicsFixture();
    const rKeys = [
      "mae_r",
      "mfe_r",
      "realized_r",
      "slippage_adverse_r",
      "violation_depth_r",
    ] as const;
    for (const key of rKeys) {
      expect(shown(forensics, key)).toBeNull();
      expect(why(forensics, key)).toBe("no_stop_on_record");
    }
  });

  it("still yields the percent representation, which needs no stop", () => {
    expect(shown(forensicsFixture(), "mae_percent")?.value).toBe(3.4);
  });

  it("reports a reason rather than nothing when a metric is missing entirely", () => {
    const forensics = forensicsFixture({ metrics: {} });
    expect(shown(forensics, "mae_percent")).toBeNull();
    expect(why(forensics, "mae_percent")).toBe("not_measured");
  });
});

const TRADE: ReviewTrade = {
  id: "t1",
  symbol: "BTCUSDT",
  side: "LONG",
  entry_price: 100,
  exit_price: 106,
  quantity: 1,
  leverage: 1,
  realized_pnl: 6,
  roi_percent: 6,
  fees: 0.1,
  stop_loss: null,
  take_profit: null,
  close_trigger: "manual_market",
  opened_at: "2026-07-26T12:00:00Z",
  closed_at: "2026-07-26T12:05:00Z",
} as ReviewTrade;

const BASELINE: UserBaseline = {
  avgLeverage: 3,
  avgDurationMs: 600_000,
  winRate: 50,
} as UserBaseline;

const CANDLES: CandleContext = {
  trend_summary: "up",
  volatility_summary: "normal",
  structure_summary: "range",
  sweep_detected: false,
  sweep_direction: null,
  entry_context: "mid-range",
  exit_context: "near high",
} as CandleContext;

describe("AI memo prompt", () => {
  const prompt = (forensics: TradeForensics | null) =>
    buildTradeContextPrompt({
      trade: TRADE,
      baseline: BASELINE,
      candleContext: CANDLES,
      severityTier: "MILD",
      mode: "normal",
      previousTrade: null,
      forensics,
    });

  it("hands the model the measured value and the unavailable reason, never a number for both", () => {
    const text = prompt(forensicsFixture());
    expect(text).toContain("MAE (% of entry): 3.4000");
    expect(text).toContain("MAE (R): UNAVAILABLE (no_stop_on_record) — do not state a value");
    expect(text).not.toMatch(/MAE \(R\): -?\d/);
  });

  it("forbids every forensic number when no row exists", () => {
    expect(prompt(null)).toContain("Do NOT state any excursion");
  });
});
