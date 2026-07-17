import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Trade, TradeCreate, TradeUpdate } from "@/lib/api/client";

export type { Trade, TradeCreate, TradeUpdate };

export class NotSignedInError extends Error {
  constructor() {
    super("Sign in to track trades.");
    this.name = "NotSignedInError";
  }
}

export interface TradesResult {
  trades: Trade[];
  authenticated: boolean;
  total: number;
}

const TRADES_KEY = ["trades"] as const;

async function fetchTrades(status?: string, page = 1, perPage = 50): Promise<TradesResult> {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (status) params.set("status", status);

  const res = await fetch(`/api/trades?${params.toString()}`, {
    credentials: "same-origin",
  });
  if (res.status === 401) return { trades: [], authenticated: false, total: 0 };
  if (!res.ok) throw new Error(`trades fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data: Trade[];
    meta: { total: number };
    error: null;
  };
  return { trades: body.data, authenticated: true, total: body.meta.total };
}

/**
 * The user's trades, server-owned (lives in Postgres, settled by the FastAPI
 * backend). Returns authenticated=false when the session cookie is missing so
 * callers can prompt for sign-in.
 */
export function useTrades(status?: string) {
  const query = useQuery({
    queryKey: [...TRADES_KEY, status],
    queryFn: () => fetchTrades(status),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const data = query.data ?? { trades: [], authenticated: true, total: 0 };
  return { ...query, trades: data.trades, authenticated: data.authenticated, total: data.total };
}

/** Open trades only. */
export function useOpenTrades() {
  return useTrades("open");
}

/** Closed trades only. */
export function useClosedTrades() {
  return useTrades("closed");
}

/** Create a new trade. Rejects with NotSignedInError on 401. */
export function useCreateTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TradeCreate): Promise<Trade> => {
      const res = await fetch("/api/trades", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 401) throw new NotSignedInError();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `create trade failed: ${res.status}`);
      }
      const body = (await res.json()) as { data: Trade };
      return body.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TRADES_KEY }),
  });
}

/** Update an existing trade (close it, add notes, etc.). */
export function useUpdateTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: TradeUpdate }): Promise<Trade> => {
      const res = await fetch(`/api/trades/${id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      if (res.status === 401) throw new NotSignedInError();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `update trade failed: ${res.status}`);
      }
      const body = (await res.json()) as { data: Trade };
      return body.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TRADES_KEY }),
  });
}

/** Delete / remove a trade from the journal. */
export function useDeleteTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/api/trades/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.status === 401) throw new NotSignedInError();
      if (!res.ok && res.status !== 404) throw new Error(`delete trade failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TRADES_KEY }),
  });
}

/** Close a trade: set exit_price, calculate pnl, mark as closed. */
export function useCloseTrade() {
  const updateTrade = useUpdateTrade();
  return {
    ...updateTrade,
    mutate: (params: { id: string; exitPrice: number; trade: Trade }) => {
      const { id, exitPrice, trade } = params;
      const pnlPerUnit =
        trade.direction === "long" ? exitPrice - trade.entry_price : trade.entry_price - exitPrice;
      const pnl = pnlPerUnit * trade.quantity * trade.leverage;
      const pnl_percent = (pnlPerUnit / trade.entry_price) * 100 * trade.leverage;

      return updateTrade.mutate({
        id,
        update: {
          exit_price: exitPrice,
          pnl: Math.round(pnl * 100) / 100,
          pnl_percent: Math.round(pnl_percent * 100) / 100,
          status: "closed",
          closed_at: new Date().toISOString(),
        },
      });
    },
  };
}
