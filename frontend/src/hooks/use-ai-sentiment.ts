import { useQuery } from "@tanstack/react-query";
import type { AiBriefResponse, AiSentimentSnapshot, SentimentHistoryItem } from "@/lib/types";

const API_BASE = "/api/v1/sentiment";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Sentiment API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

/**
 * Latest AI-powered news sentiment snapshot — aggregated market sentiment,
 * per-asset breakdown, key narratives, and AI brief.
 */
export const useAiSentiment = () =>
  useQuery<AiSentimentSnapshot>({
    queryKey: ["ai-sentiment", "current"],
    queryFn: () => fetchJson<AiSentimentSnapshot>(`${API_BASE}/current`),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: 1,
    // Silently return undefined if not configured yet
    throwOnError: false,
  });

/**
 * Sentiment score history for timeline charts.
 */
export const useSentimentHistory = (limit = 48) =>
  useQuery<{ data: SentimentHistoryItem[] }>({
    queryKey: ["ai-sentiment", "history", limit],
    queryFn: () => fetchJson<{ data: SentimentHistoryItem[] }>(`${API_BASE}/history?limit=${limit}`),
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
    retry: 1,
    throwOnError: false,
  });

/**
 * Latest AI-generated news brief text.
 */
export const useAiNewsBrief = () =>
  useQuery<AiBriefResponse>({
    queryKey: ["ai-sentiment", "brief"],
    queryFn: () => fetchJson<AiBriefResponse>(`${API_BASE}/news-brief`),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: 1,
    throwOnError: false,
  });

/**
 * Sentiment engine status — whether it's configured and running.
 */
export const useSentimentStatus = () =>
  useQuery<{ status: string; configured: boolean; model: string; lastRunAt: string | null }>({
    queryKey: ["ai-sentiment", "status"],
    queryFn: () => fetchJson(`${API_BASE}/status`),
    staleTime: 60_000,
    retry: 1,
    throwOnError: false,
  });
