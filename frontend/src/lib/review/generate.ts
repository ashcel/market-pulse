// Trade Review generation pipeline — orchestrates severity scoring, candle
// fetch/preprocessing, prompt building, and the BYOK LLM call, then persists
// the finished review to the backend. Runs entirely in the browser: the only
// network calls this module makes are (1) this app's own /api/klines proxy
// (public market data, no secrets), (2) the user's chosen AI provider via
// runAiAnalyst (their key, sent straight from the browser), and (3) POSTing
// the finished review JSON to /api/review/:id. The AI provider key never
// touches this app's server — see CLAUDE.md's BYOK invariant.

import { runAiWithFallback } from "@/lib/ai/chain";
import type { AiMessage } from "@/lib/ai/client";
import type { AiSettingsSnapshot } from "@/lib/ai/providers";
import type { Candle } from "@/lib/engine/types";

import { preprocessCandles, unavailableCandleContext } from "./candles";
import { buildSystemPrompt, buildTradeContextPrompt, parseAndValidateReview } from "./prompt";
import { buildUserBaseline, computeSeverity, toSeverityInput } from "./severity";
import type { CandleContext, ReviewMode, ReviewTrade, TradeReview } from "./types";

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const PRE_WINDOW_MS = 90 * 60 * 1000; // 6 candles of context before entry
const POST_WINDOW_MS = 90 * 60 * 1000; // 6 candles of context after exit
const MAX_CANDLES = 1000;

/** Strip the trailing "USDT" quote asset — the AssetIcon/klines API want the base ticker. */
function baseSymbol(symbol: string): string {
  return symbol.endsWith("USDT") ? symbol.slice(0, -"USDT".length) : symbol;
}

/** Find the closed trade that closed most recently before this one opened. */
function findPreviousTrade(trade: ReviewTrade, allTrades: ReviewTrade[]): ReviewTrade | null {
  const openedMs = new Date(trade.opened_at).getTime();
  let best: ReviewTrade | null = null;
  let bestClosedMs = -Infinity;
  for (const candidate of allTrades) {
    if (candidate.id === trade.id) continue;
    const closedMs = new Date(candidate.closed_at).getTime();
    if (!Number.isFinite(closedMs) || closedMs >= openedMs) continue;
    if (closedMs > bestClosedMs) {
      best = candidate;
      bestClosedMs = closedMs;
    }
  }
  return best;
}

async function fetchTradeCandleContext(trade: ReviewTrade): Promise<CandleContext> {
  try {
    const openedMs = new Date(trade.opened_at).getTime();
    const closedMs = new Date(trade.closed_at).getTime();
    if (!Number.isFinite(openedMs) || !Number.isFinite(closedMs)) {
      return unavailableCandleContext();
    }

    const durationMs = Math.max(closedMs - openedMs, 0);
    const windowMs = PRE_WINDOW_MS + durationMs + POST_WINDOW_MS;
    const limit = Math.min(MAX_CANDLES, Math.max(20, Math.ceil(windowMs / FIFTEEN_MIN_MS) + 4));
    const endTime = closedMs + POST_WINDOW_MS;

    const params = new URLSearchParams({
      symbol: baseSymbol(trade.symbol),
      timeframe: "15M",
      market: "perp",
      endTime: String(endTime),
      limit: String(limit),
    });
    const res = await fetch(`/api/klines?${params.toString()}`, { credentials: "same-origin" });
    if (!res.ok) return unavailableCandleContext();
    const candles = (await res.json()) as Candle[];
    if (!Array.isArray(candles) || candles.length === 0) return unavailableCandleContext();

    const before: Candle[] = [];
    const during: Candle[] = [];
    const after: Candle[] = [];
    for (const candle of candles) {
      const candleMs = candle.time * 1000;
      if (candleMs < openedMs) before.push(candle);
      else if (candleMs > closedMs) after.push(candle);
      else during.push(candle);
    }

    return preprocessCandles(
      before,
      during,
      after,
      trade.entry_price,
      trade.exit_price,
      trade.side,
    );
  } catch {
    return unavailableCandleContext();
  }
}

export interface GenerateReviewOptions {
  trade: ReviewTrade;
  allTrades: ReviewTrade[];
  mode: ReviewMode;
  /**
   * The user's stored AI settings. The chain resolves them into an ordered
   * candidate list (their provider first, then the configured fallbacks), so a
   * single provider outage no longer costs the whole review.
   */
  aiSettings: AiSettingsSnapshot;
  signal?: AbortSignal;
}

/**
 * Generate a Trade Review for one trade. Fully client-side: severity scoring
 * and prompt building are pure, the LLM call goes straight to the user's
 * provider, and only the finished JSON is sent to this app's server (to
 * persist under /api/review/:id).
 */
export async function generateReview(options: GenerateReviewOptions): Promise<TradeReview> {
  const { trade, allTrades, mode, aiSettings, signal } = options;

  const previousTrade = findPreviousTrade(trade, allTrades);
  const baseline = buildUserBaseline(allTrades);
  const severityInput = toSeverityInput(trade, [], previousTrade);
  const { score: severityScore, tier: severityTier } = computeSeverity(severityInput, baseline);

  const candleContext = await fetchTradeCandleContext(trade);

  const system = buildSystemPrompt(mode, severityTier);
  const userPrompt = buildTradeContextPrompt({
    trade,
    baseline,
    candleContext,
    severityTier,
    mode,
    previousTrade,
  });

  const messages: AiMessage[] = [{ role: "user", content: userPrompt }];
  const completion = await runAiWithFallback({
    settings: aiSettings,
    system,
    messages,
    signal,
    maxTokens: 2000,
  });
  const review = parseAndValidateReview(completion.text);

  // The backend stores full_review verbatim plus a few denormalized columns
  // (review_mode/severity/grade/one_liner) for cheap list-view queries — see
  // TradeReviewCreate in backend/app/review/schemas.py.
  const res = await fetch(`/api/review/${trade.id}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      review_mode: review.review_mode,
      severity_score: severityScore,
      severity_tier: review.severity_tier,
      grade: review.grade,
      one_liner: review.one_liner,
      full_review: review,
      model_used: completion.model,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `failed to save review: ${res.status}`);
  }

  return review;
}
