import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export class NotSignedInError extends Error {
  constructor() {
    super("Sign in to view or edit your Trading Constitution.");
    this.name = "NotSignedInError";
  }
}

const CONSTITUTION_KEY = ["execution", "constitution"] as const;

/** Mirrors backend/app/execution/schemas.py — ConstitutionResponse. */
export interface TradingConstitution {
  id: string;
  user_id: string;
  version: number;
  risk_per_trade_percent: number;
  daily_loss_limit_percent: number;
  weekly_loss_limit_percent: number;
  max_leverage: number;
  max_concurrent_positions: number;
  max_correlated_exposure_percent: number;
  min_risk_reward: number;
  allowed_sessions: string[];
  allowed_symbols: string[];
  binding_cooldowns: Record<string, boolean>;
  created_at: string;
}

/** Mirrors backend/app/execution/schemas.py — ConstitutionCreate. */
export interface ConstitutionInput {
  risk_per_trade_percent: number;
  daily_loss_limit_percent: number;
  weekly_loss_limit_percent: number;
  max_leverage: number;
  max_concurrent_positions: number;
  max_correlated_exposure_percent: number;
  min_risk_reward: number;
  allowed_sessions: string[];
  allowed_symbols: string[];
  binding_cooldowns: Record<string, boolean>;
}

export interface ConstitutionFieldError {
  field: string;
  code: string;
  message: string;
}

export class ConstitutionValidationError extends Error {
  errors: ConstitutionFieldError[];
  constructor(errors: ConstitutionFieldError[]) {
    super(errors.map((e) => e.message).join("; ") || "Constitution failed validation.");
    this.name = "ConstitutionValidationError";
    this.errors = errors;
  }
}

interface ConstitutionResult {
  constitution: TradingConstitution | null;
  authenticated: boolean;
}

async function fetchConstitution(): Promise<ConstitutionResult> {
  const res = await fetch("/api/execution/constitution", { credentials: "same-origin" });
  if (res.status === 401) return { constitution: null, authenticated: false };
  // ConstitutionNotFoundError → 404 when no version has been created yet.
  if (res.status === 404) return { constitution: null, authenticated: true };
  if (!res.ok) throw new Error(`constitution fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: TradingConstitution };
  return { constitution: body.data, authenticated: true };
}

/** The signed-in user's current (highest-version) Trading Constitution, or null if none yet. */
export function useConstitution() {
  const query = useQuery({
    queryKey: CONSTITUTION_KEY,
    queryFn: fetchConstitution,
    staleTime: 30_000,
  });
  const data = query.data ?? { constitution: null, authenticated: true };
  return { ...query, constitution: data.constitution, authenticated: data.authenticated };
}

/** Create a new constitution version. Every accepted edit is server-side audited. */
export function useSaveConstitution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConstitutionInput): Promise<TradingConstitution> => {
      const res = await fetch("/api/execution/constitution", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 401) throw new NotSignedInError();
      if (res.status === 422) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { details?: { errors?: ConstitutionFieldError[] } };
        };
        throw new ConstitutionValidationError(body.error?.details?.errors ?? []);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `save constitution failed: ${res.status}`);
      }
      const body = (await res.json()) as { data: TradingConstitution };
      return body.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(CONSTITUTION_KEY, { constitution: data, authenticated: true });
    },
  });
}
