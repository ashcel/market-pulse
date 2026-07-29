import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type AlertType =
  | "entry_zone"
  | "verdict_change"
  | "invalidation"
  | "catalyst"
  | "behavior_cooldown";

export interface DecisionAlert {
  id: string;
  type: AlertType;
  token_symbol: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  read: boolean;
  created_at: string;
  delivered_at: string | null;
  source_decision_id: string | null;
}

interface AlertsEnvelope {
  data: DecisionAlert[];
  meta: { page: number; per_page: number; total: number };
}

const ALERTS_KEY = ["alerts"] as const;

async function fetchAlerts(): Promise<AlertsEnvelope> {
  const res = await fetch("/api/alerts?page=1&per_page=20", { credentials: "same-origin" });
  if (res.status === 401) return { data: [], meta: { page: 1, per_page: 20, total: 0 } };
  if (!res.ok) throw new Error(`alerts fetch failed: ${res.status}`);
  return (await res.json()) as AlertsEnvelope;
}

export function useAlerts() {
  return useQuery({
    queryKey: ALERTS_KEY,
    queryFn: fetchAlerts,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useMarkAlertRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/alerts/${encodeURIComponent(id)}/read`, {
        method: "PATCH",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`mark alert read failed: ${res.status}`);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ALERTS_KEY }),
  });
}

export function useMarkAllAlertsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/alerts", { method: "POST", credentials: "same-origin" });
      if (!res.ok) throw new Error(`mark alerts read failed: ${res.status}`);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ALERTS_KEY }),
  });
}
