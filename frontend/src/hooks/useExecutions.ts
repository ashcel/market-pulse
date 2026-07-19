import { useQuery } from "@tanstack/react-query";

/**
 * Read-only Execution Records for the Trade Review page — user-confirmed
 * Binance (testnet) order placements from the M9 execution plane. These are
 * order-submission facts (entry/stop/target, quantity, status), never
 * PnL-settled trades: `ExecutionRecord` has no exit price or realized PnL
 * (see backend/app/execution/models.py), so none is fabricated here.
 */
export interface ExecutionRecord {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  entry_type: string;
  entry_price: number;
  stop_price: number;
  target_price: number | null;
  quantity: number;
  filled_quantity: number;
  leverage: number;
  status: string;
  entry_order_id: string | null;
  flattened: boolean;
  created_at: string;
}

export interface ExecutionsResult {
  executions: ExecutionRecord[];
  authenticated: boolean;
  total: number;
}

const EXECUTIONS_KEY = ["execution", "executions"] as const;

async function fetchExecutions(): Promise<ExecutionsResult> {
  const res = await fetch("/api/execution/executions", { credentials: "same-origin" });
  if (res.status === 401) return { executions: [], authenticated: false, total: 0 };
  if (!res.ok) throw new Error(`executions fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: ExecutionRecord[]; meta: { total: number } };
  return { executions: body.data, authenticated: true, total: body.meta.total };
}

/** Recent execution (order-placement) records, newest first. Never writes. */
export function useExecutions() {
  const query = useQuery({
    queryKey: EXECUTIONS_KEY,
    queryFn: fetchExecutions,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const data = query.data ?? { executions: [], authenticated: true, total: 0 };
  return {
    ...query,
    executions: data.executions,
    authenticated: data.authenticated,
    total: data.total,
  };
}
