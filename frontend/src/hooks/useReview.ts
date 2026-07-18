import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { generateReview } from "@/lib/review/generate";
import { resolveAiConfig } from "@/lib/ai/providers";
import type { Analytics, ReviewMode, ReviewTrade, TradeReview } from "@/lib/review/types";
import { useAiSettingsStore } from "@/stores/ai-settings";

export class NotSignedInError extends Error {
  constructor() {
    super("Sign in to use Trade Review.");
    this.name = "NotSignedInError";
  }
}

const REVIEW_KEY = ["review"] as const;
const BYBIT_KEY_STATUS_KEY = [...REVIEW_KEY, "bybit-key-status"] as const;
const ANALYTICS_KEY = [...REVIEW_KEY, "analytics"] as const;
const TRADES_KEY = [...REVIEW_KEY, "trades"] as const;
const TRADE_REVIEW_KEY = [...REVIEW_KEY, "trade"] as const;

// ── Bybit connection ────────────────────────────────────────────────────────

export interface BybitKeyStatus {
  connected: boolean;
  lastSyncedAt: string | null;
  authenticated: boolean;
}

async function fetchBybitKeyStatus(): Promise<BybitKeyStatus> {
  const res = await fetch("/api/bybit/api-key", { credentials: "same-origin" });
  if (res.status === 401) return { connected: false, lastSyncedAt: null, authenticated: false };
  // BybitKeyNotFoundError → 404 when the user hasn't connected an account yet.
  if (res.status === 404) return { connected: false, lastSyncedAt: null, authenticated: true };
  if (!res.ok) throw new Error(`bybit key status fetch failed: ${res.status}`);
  // BybitApiKeyResponse: { id, user_id, api_key (masked), status, last_sync_at, ... }
  const body = (await res.json()) as {
    data: { status?: string; last_sync_at?: string | null } | null;
  };
  return {
    connected: Boolean(body.data),
    lastSyncedAt: body.data?.last_sync_at ?? null,
    authenticated: true,
  };
}

/** Whether the signed-in user has a Bybit API key on file (never exposes the secret). */
export function useBybitKeyStatus() {
  const query = useQuery({
    queryKey: BYBIT_KEY_STATUS_KEY,
    queryFn: fetchBybitKeyStatus,
    staleTime: 30_000,
  });
  const data = query.data ?? { connected: false, lastSyncedAt: null, authenticated: true };
  return { ...query, ...data };
}

/** Save (or replace) the Bybit API key + secret. Stored server-side — NOT BYOK. */
export function useSaveBybitKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { apiKey: string; apiSecret: string }): Promise<void> => {
      const res = await fetch("/api/bybit/api-key", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: input.apiKey, api_secret: input.apiSecret }),
      });
      if (res.status === 401) throw new NotSignedInError();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `save bybit key failed: ${res.status}`);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BYBIT_KEY_STATUS_KEY }),
  });
}

/** Disconnect the Bybit account (removes the stored key+secret). */
export function useDeleteBybitKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch("/api/bybit/api-key", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.status === 401) throw new NotSignedInError();
      if (!res.ok && res.status !== 404) throw new Error(`delete bybit key failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BYBIT_KEY_STATUS_KEY }),
  });
}

/** Trigger a Bybit trade-history sync for the signed-in user. */
export function useSyncBybit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch("/api/bybit/sync", { method: "POST", credentials: "same-origin" });
      if (res.status === 401) throw new NotSignedInError();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `sync failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRADES_KEY });
      void queryClient.invalidateQueries({ queryKey: ANALYTICS_KEY });
      void queryClient.invalidateQueries({ queryKey: BYBIT_KEY_STATUS_KEY });
    },
  });
}

// ── Analytics ────────────────────────────────────────────────────────────────

async function fetchAnalytics(): Promise<{ analytics: Analytics | null; authenticated: boolean }> {
  const res = await fetch("/api/review/analytics", { credentials: "same-origin" });
  if (res.status === 401) return { analytics: null, authenticated: false };
  if (!res.ok) throw new Error(`analytics fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: Analytics };
  return { analytics: body.data, authenticated: true };
}

/** The 5-analytic Trade Review read model (RR, best/worst, time-of-day, sessions, style). */
export function useReviewAnalytics() {
  const query = useQuery({
    queryKey: ANALYTICS_KEY,
    queryFn: fetchAnalytics,
    staleTime: 30_000,
  });
  const data = query.data ?? { analytics: null, authenticated: true };
  return { ...query, analytics: data.analytics, authenticated: data.authenticated };
}

// ── Synced trades ────────────────────────────────────────────────────────────

export interface ReviewTradesResult {
  trades: ReviewTrade[];
  authenticated: boolean;
  total: number;
}

async function fetchReviewTrades(symbol?: string): Promise<ReviewTradesResult> {
  // GET /bybit/trades filters by `symbol` (base+quote, e.g. "BTCUSDT") and
  // paginates via page/per_page — there is no trade-status field on
  // BybitTradeResponse (every synced trade is a closed round-trip).
  const params = new URLSearchParams();
  if (symbol) params.set("symbol", symbol);
  const qs = params.toString();
  const res = await fetch(`/api/bybit/trades${qs ? `?${qs}` : ""}`, { credentials: "same-origin" });
  if (res.status === 401) return { trades: [], authenticated: false, total: 0 };
  if (!res.ok) throw new Error(`review trades fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: ReviewTrade[]; meta: { total: number } };
  return { trades: body.data, authenticated: true, total: body.meta.total };
}

/** Synced Bybit trades feeding the Trade Review page (distinct from the manual /trades journal). */
export function useReviewTrades(symbol?: string) {
  const query = useQuery({
    queryKey: [...TRADES_KEY, symbol],
    queryFn: () => fetchReviewTrades(symbol),
    staleTime: 30_000,
  });
  const data = query.data ?? { trades: [], authenticated: true, total: 0 };
  return { ...query, trades: data.trades, authenticated: data.authenticated, total: data.total };
}

// ── Per-trade AI review ──────────────────────────────────────────────────────

async function fetchTradeReview(id: string): Promise<TradeReview | null> {
  const res = await fetch(`/api/review/${id}`, { credentials: "same-origin" });
  if (res.status === 404) return null;
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`review fetch failed: ${res.status}`);
  // TradeReviewResponse wraps the client-generated JSON verbatim under
  // full_review, alongside denormalized columns (grade, one_liner, ...) used
  // for cheap list queries — see backend/app/review/schemas.py.
  const body = (await res.json()) as { data: { full_review: TradeReview } };
  return body.data.full_review;
}

/** A previously generated review for one trade, or null if none exists yet. */
export function useTradeReview(id: string | undefined) {
  return useQuery({
    queryKey: [...TRADE_REVIEW_KEY, id],
    queryFn: () => fetchTradeReview(id as string),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export interface GenerateTradeReviewInput {
  trade: ReviewTrade;
  allTrades: ReviewTrade[];
  mode?: ReviewMode;
}

/**
 * Generate an AI review for a trade — fully client-side (severity scoring,
 * prompt building, and the LLM call all run in the browser using the user's
 * BYOK AI settings). Only the finished review JSON is sent to this app's
 * server, via generateReview()'s POST to /api/review/:id.
 */
export function useGenerateTradeReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: GenerateTradeReviewInput): Promise<TradeReview> => {
      const aiConfig = resolveAiConfig(useAiSettingsStore.getState());
      if (!aiConfig) {
        throw new Error("Configure an AI provider in Settings before generating a review.");
      }
      return generateReview({
        trade: input.trade,
        allTrades: input.allTrades,
        mode: input.mode ?? "normal",
        aiConfig,
      });
    },
    onSuccess: (review, variables) => {
      queryClient.setQueryData([...TRADE_REVIEW_KEY, variables.trade.id], review);
    },
  });
}
