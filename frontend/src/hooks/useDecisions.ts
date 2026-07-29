import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type DecisionAction = "accepted_skip" | "rejected_skip" | "took_trade" | "ignored";

export interface DecisionSnapshot {
  id: string;
  user_id: string;
  symbol: string;
  objective: "scalp" | "intraday" | "swing";
  direction: "long" | "short";
  verdict_at_time: string;
  catalyst_modifier: Record<string, unknown> | null;
  skip_check_result: Record<string, unknown> | null;
  entry_zone: Record<string, unknown> | null;
  stop_loss: number | null;
  take_profit: number | null;
  user_action: DecisionAction | null;
  actual_outcome: Record<string, unknown> | null;
  engine_version: string;
  created_at: string;
  decided_at: string | null;
}

export type DecisionCreate = Omit<
  DecisionSnapshot,
  "id" | "user_id" | "user_action" | "actual_outcome" | "created_at" | "decided_at"
>;

const DECISIONS_KEY = ["decisions"] as const;

async function readData(res: Response): Promise<DecisionSnapshot> {
  if (!res.ok) throw new Error(`decision request failed: ${res.status}`);
  return ((await res.json()) as { data: DecisionSnapshot }).data;
}

export async function createDecision(input: DecisionCreate): Promise<DecisionSnapshot> {
  return readData(
    await fetch("/api/decisions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function setDecisionAction(
  id: string,
  user_action: DecisionAction,
  actual_outcome?: Record<string, unknown>,
): Promise<DecisionSnapshot> {
  return readData(
    await fetch(`/api/decisions/${id}/action`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_action, actual_outcome }),
    }),
  );
}

export function useDecisions() {
  const query = useQuery({
    queryKey: DECISIONS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/decisions?per_page=100", { credentials: "same-origin" });
      if (res.status === 401) return [];
      if (!res.ok) throw new Error(`decisions fetch failed: ${res.status}`);
      return ((await res.json()) as { data: DecisionSnapshot[] }).data;
    },
    staleTime: 30_000,
  });
  return { ...query, decisions: query.data ?? [] };
}

export function useDecisionAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      outcome,
    }: {
      id: string;
      action: DecisionAction;
      outcome?: Record<string, unknown>;
    }) => setDecisionAction(id, action, outcome),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DECISIONS_KEY }),
  });
}
