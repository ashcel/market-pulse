import { useQuery } from "@tanstack/react-query";

/**
 * The frozen measurement shape (docs/forensics-definitions.md §2). Value,
 * availability and reason always travel together, so an unsupported
 * measurement can never be rendered as 0, —, or an omitted field.
 */
export interface MetricValue {
  available: boolean;
  value: number | null;
  unit: string;
  reason: string | null;
  flags: string[];
  forensics_version: string;
}

export type MetricKey =
  | "mae_price"
  | "mae_percent"
  | "mae_r"
  | "mfe_price"
  | "mfe_percent"
  | "mfe_r"
  | "exit_efficiency"
  | "slippage_adverse"
  | "slippage_adverse_pct"
  | "slippage_adverse_r"
  | "violation_depth_r"
  | "realized_r"
  | "reentry_latency_seconds"
  | "sizing_notional"
  | "sizing_size_ratio"
  | "sizing_cv_percent"
  | "sizing_median"
  | "sizing_iqr"
  | "sizing_q1"
  | "sizing_q3"
  | "sizing_mean";

export interface TradeForensics {
  id: string;
  user_id: string;
  binance_trade_id: string;
  forensics_version: string;
  kline_interval: string | null;
  kline_candles_in_window: number | null;
  boundary_inflation_bound_pct: number | null;
  metrics: Partial<Record<MetricKey, MetricValue>>;
  stop_evidence: "hit" | "liquidated" | "absent";
  discipline_breach: boolean;
  partial_close_suspected: boolean;
  reentry_same_direction: boolean | null;
  reentry_after_loss: boolean | null;
  sizing_mode: string | null;
  sizing_n: number | null;
  sizing_excluded: number | null;
  sizing_partial_close_rows: number | null;
  created_at: string;
}

/** A metric that is present *and* available — the only thing safe to render. */
export function shown(
  forensics: TradeForensics,
  key: MetricKey,
): (MetricValue & { value: number }) | null {
  const metric = forensics.metrics[key];
  if (!metric?.available || metric.value === null || !Number.isFinite(metric.value)) return null;
  return metric as MetricValue & { value: number };
}

/** The reason a metric is unavailable — never null when `shown` returns null. */
export function why(forensics: TradeForensics, key: MetricKey): string {
  return forensics.metrics[key]?.reason ?? "not_measured";
}

export interface ForensicsMeta {
  page: number;
  per_page: number;
  total: number;
  total_pages?: number;
}

const FORENSICS_KEY = ["review", "forensics"] as const;

export async function fetchTradeForensics(tradeId: string): Promise<TradeForensics | null> {
  const res = await fetch(`/api/review/forensics/${encodeURIComponent(tradeId)}`, {
    credentials: "same-origin",
  });
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error(`trade forensics fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: TradeForensics };
  return body.data;
}

async function fetchForensicsList(page: number, perPage: number) {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  const res = await fetch(`/api/review/forensics?${params}`, { credentials: "same-origin" });
  if (res.status === 401) return { data: [], meta: { page, per_page: perPage, total: 0 } };
  if (!res.ok) throw new Error(`forensics list fetch failed: ${res.status}`);
  return (await res.json()) as { data: TradeForensics[]; meta: ForensicsMeta };
}

export function useTradeForensics(tradeId: string, enabled = true) {
  return useQuery({
    queryKey: [...FORENSICS_KEY, "trade", tradeId],
    queryFn: () => fetchTradeForensics(tradeId),
    enabled: Boolean(tradeId) && enabled,
    staleTime: 60_000,
  });
}

export function useForensicsList(page: number, perPage: number) {
  return useQuery({
    queryKey: [...FORENSICS_KEY, "list", page, perPage],
    queryFn: () => fetchForensicsList(page, perPage),
    staleTime: 30_000,
  });
}
