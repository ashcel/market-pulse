/**
 * API client for the FastAPI backend (market-pulse-api, port 8002).
 *
 * All calls go through this client. In production both services are behind
 * Caddy so requests always use the internal base URL. In development the
 * FastAPI service runs on :8002.
 *
 * The client accepts either:
 * - A JWT Bearer token (for direct browser calls with password-auth users).
 * - Internal server-to-server calls are handled via X-Internal-* headers
 *   from the TanStack Start proxy routes — never sent from the browser.
 */

export const API_BASE = process.env.VITE_API_BASE ?? "http://localhost:8002";

export type ApiEnvelope<T> = {
  data: T;
  meta: Record<string, unknown> | null;
  error: { code: string; message: string; details?: unknown } | null;
};

export type PaginatedEnvelope<T> = {
  data: T[];
  meta: { page: number; per_page: number; total: number; total_pages: number };
  error: null;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...init } = options;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string>),
  };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    let code = "UNKNOWN";
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as ApiEnvelope<unknown>;
      if (body.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // ignore parse error
    }
    throw new ApiError(res.status, code, message);
  }

  return (await res.json()) as T;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface UserResponse {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
}

export async function apiRegister(
  email: string,
  displayName: string,
  password: string,
): Promise<ApiEnvelope<UserResponse>> {
  return apiFetch<ApiEnvelope<UserResponse>>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, display_name: displayName, password }),
  });
}

export async function apiLogin(
  email: string,
  password: string,
): Promise<ApiEnvelope<TokenResponse>> {
  return apiFetch<ApiEnvelope<TokenResponse>>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function apiGetMe(token: string): Promise<ApiEnvelope<UserResponse>> {
  return apiFetch<ApiEnvelope<UserResponse>>("/auth/me", { token });
}

// ── Market ────────────────────────────────────────────────────────────────────

export interface MarketToken {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  volume_24h: number | null;
  change_24h: number | null;
  updated_at: string | null;
}

export async function apiGetTokens(
  page = 1,
  perPage = 20,
): Promise<PaginatedEnvelope<MarketToken>> {
  return apiFetch<PaginatedEnvelope<MarketToken>>(
    `/market/tokens?page=${page}&per_page=${perPage}`,
  );
}

// ── Trades ────────────────────────────────────────────────────────────────────

export interface Trade {
  id: string;
  user_id: string;
  symbol: string;
  direction: "long" | "short";
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  leverage: number;
  pnl: number | null;
  pnl_percent: number | null;
  status: "open" | "closed" | "cancelled";
  strategy: string | null;
  notes: string | null;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface TradeCreate {
  symbol: string;
  direction: "long" | "short";
  entry_price: number;
  quantity: number;
  leverage?: number;
  strategy?: string | null;
  notes?: string | null;
  opened_at?: string | null;
}

export interface TradeUpdate {
  exit_price?: number | null;
  pnl?: number | null;
  pnl_percent?: number | null;
  status?: "open" | "closed" | "cancelled";
  notes?: string | null;
  closed_at?: string | null;
}
