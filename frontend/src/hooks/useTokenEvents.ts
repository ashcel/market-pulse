import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { useWatchlistStore } from "@/stores/watchlist";
import type { TokenEventKind, TokenEventSeverity } from "@/lib/engine/token-events";

/** Mirrors the server's TokenEventRow without importing server code. */
export interface TokenEvent {
  id: string;
  symbol: string;
  kind: TokenEventKind;
  severity: TokenEventSeverity;
  title: string;
  body: string | null;
  source: string;
  url: string | null;
  publishedAt: string;
  createdAt: string;
}

/** Recent typed events (unlocks, security, regulatory...) for one token. */
export function useTokenEvents(symbol: string) {
  return useQuery<TokenEvent[]>({
    queryKey: ["token-events", symbol.toUpperCase()],
    queryFn: async () => {
      const res = await fetch(`/api/token-events?symbol=${encodeURIComponent(symbol)}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return [];
      return (await res.json()) as TokenEvent[];
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/**
 * Last-7d events for a batch of tokens in one request (≤16 symbols) — used by
 * the homepage opportunity scanner for contextual badges. Returns a flat list;
 * callers group by `symbol`.
 */
export function useTokenEventsForSymbols(symbols: string[]) {
  const key = [...new Set(symbols.map((s) => s.toUpperCase()))].sort();
  return useQuery<TokenEvent[]>({
    queryKey: ["token-events", "batch", key.join(",")],
    enabled: key.length > 0,
    queryFn: async () => {
      const res = await fetch(`/api/token-events?symbols=${encodeURIComponent(key.join(","))}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return [];
      return (await res.json()) as TokenEvent[];
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

const SYNC_DEBOUNCE_MS = 2_000;

/**
 * Keeps the local watchlist and the server-side one (Phase 2.5) in sync for
 * signed-in users: on mount, merge server ∪ local and push the union back;
 * afterwards every local change PUTs the full list (debounced). A 401 at any
 * step just means signed-out — the local store keeps working alone, and the
 * next signed-in session merges. Mounted once in the root layout.
 */
export function useWatchlistSync(enabled = true) {
  const tickers = useWatchlistStore((s) => s.tickers);
  const bootstrapped = useRef(false);
  const skipNextPush = useRef(false);

  // One-time merge on load.
  useEffect(() => {
    if (!enabled || bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      try {
        const res = await fetch("/api/watchlist", { credentials: "same-origin" });
        if (!res.ok) return; // signed out (401) or transient — stay local-only
        const server = ((await res.json()) as { tickers: string[] }).tickers;
        const local = useWatchlistStore.getState().tickers;
        const merged = [...new Set([...server, ...local])];
        if (merged.length !== local.length) {
          skipNextPush.current = true;
          useWatchlistStore.setState({ tickers: merged });
        }
        await fetch("/api/watchlist", {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tickers: merged }),
        });
      } catch {
        // Offline — nothing to sync.
      }
    })();
  }, [enabled]);

  // Debounced push on every subsequent local change.
  useEffect(() => {
    if (!enabled || !bootstrapped.current) return;
    if (skipNextPush.current) {
      skipNextPush.current = false;
      return;
    }
    const t = setTimeout(() => {
      fetch("/api/watchlist", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tickers }),
      }).catch(() => {});
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [tickers, enabled]);
}
