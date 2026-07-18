// Severity Scorer — computes a 0-100 severity score before calling the LLM.
// This score controls tone within the selected review mode. Ported from
// tradereview's lib/services/severity-scorer.ts; pure, no DB access — the
// caller (generate.ts) supplies numbers straight from ReviewTrade instead of
// the source app's stringly-typed DB rows.

import type {
  PreviousTradeContext,
  ReviewTrade,
  SeverityResult,
  SeverityTier,
  TradeDataForSeverity,
  UserBaseline,
} from "./types";

const SEVERE_TAGS = ["revenge trade", "overleverage", "emotional exit", "no stop loss"];
const MODERATE_TAGS = [
  "early entry",
  "moved stop loss",
  "FOMO entry",
  "FOMO / Pre-Confirmation Entry",
];

export function computeSeverity(
  trade: TradeDataForSeverity,
  baseline: UserBaseline,
): SeverityResult {
  let score = 0;

  // 1. ROI Loss % (max 25 pts)
  if (trade.roi < 0) {
    const absRoi = Math.abs(trade.roi);
    if (absRoi >= 50) score += 25;
    else if (absRoi >= 20) score += 18;
    else if (absRoi >= 10) score += 10;
    else score += 5;
  }

  // 2. Leverage vs User Baseline (max 20 pts)
  const leverageRatio = baseline.avgLeverage > 0 ? trade.leverage / baseline.avgLeverage : 1;
  if (leverageRatio >= 3) score += 20;
  else if (leverageRatio >= 2) score += 12;
  else if (leverageRatio >= 1.5) score += 6;

  // 3. Behavioral Tags (max 25 pts) — always 0 today: no tag system exists yet.
  const tagScore = trade.behavioralTags.reduce((acc, tag) => {
    const tagLower = tag.toLowerCase();
    if (SEVERE_TAGS.some((st) => tagLower.includes(st.toLowerCase()))) return acc + 7;
    if (MODERATE_TAGS.some((mt) => tagLower.includes(mt.toLowerCase()))) return acc + 3;
    return acc;
  }, 0);
  score += Math.min(tagScore, 25);

  // 4. Liquidated (auto bump — account ruin territory)
  if (trade.liquidated || trade.closeTrigger === "liquidation") {
    score = 100;
  }

  // 5. Sequence Context (max 15 pts)
  if (trade.previousTrade) {
    const timeSincePrev = trade.openTime - trade.previousTrade.closeTime; // ms
    const fiveMinutes = 5 * 60 * 1000;
    const isQuickReentry = timeSincePrev > 0 && timeSincePrev < fiveMinutes;

    if (trade.previousTrade.result === "loss" && isQuickReentry) {
      score += 15; // classic revenge trade signal
    } else if (trade.previousTrade.result === "win" && isQuickReentry && leverageRatio >= 1.5) {
      score += 10; // overconfidence after win
    }
  }

  score = Math.min(score, 100);

  let tier: SeverityTier;
  if (score >= 85) tier = "CRITICAL";
  else if (score >= 61) tier = "HIGH";
  else if (score >= 31) tier = "MODERATE";
  else tier = "MILD";

  return { score, tier };
}

/** Build a user baseline from recent closed trades (for leverage/duration/win-rate context). */
export function buildUserBaseline(trades: ReviewTrade[]): UserBaseline {
  const closed = trades.filter((t) => t.opened_at && t.closed_at);
  if (closed.length === 0) {
    return { avgLeverage: 10, avgDurationMs: 60 * 60 * 1000, winRate: 50 };
  }

  const leverages = closed.map((t) => t.leverage).filter((l) => l > 0);
  const avgLeverage =
    leverages.length > 0 ? leverages.reduce((a, b) => a + b, 0) / leverages.length : 10;

  const durations = closed
    .map((t) => new Date(t.closed_at).getTime() - new Date(t.opened_at).getTime())
    .filter((d) => d > 0);
  const avgDurationMs =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 60 * 60 * 1000;

  const wins = closed.filter((t) => t.realized_pnl > 0).length;
  const winRate = (wins / closed.length) * 100;

  return { avgLeverage, avgDurationMs, winRate };
}

/** Map a ReviewTrade (+ prior trade, if any) into severity-scorer input. */
export function toSeverityInput(
  trade: ReviewTrade,
  behavioralTags: string[],
  previous: ReviewTrade | null,
): TradeDataForSeverity {
  const roi = trade.roi_percent ?? 0;
  const isLiquidated =
    roi <= -100 ||
    (trade.realized_pnl < 0 && Math.abs(roi) > 99) ||
    trade.close_trigger === "liquidation";

  const previousTrade: PreviousTradeContext | null = previous
    ? {
        closeTime: previous.closed_at ? new Date(previous.closed_at).getTime() : 0,
        result: previous.realized_pnl > 0 ? "win" : "loss",
        pnl: previous.realized_pnl,
      }
    : null;

  return {
    roi,
    leverage: trade.leverage,
    liquidated: isLiquidated,
    behavioralTags,
    openTime: trade.opened_at ? new Date(trade.opened_at).getTime() : Date.now(),
    previousTrade,
    closeTrigger: trade.close_trigger,
  };
}
