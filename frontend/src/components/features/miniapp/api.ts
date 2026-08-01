/**
 * Mini App credential plumbing.
 *
 * Two credentials, one login (see `routes/api/auth.telegram.ts`):
 *   - `mp_session` cookie — set by the web tier, makes every existing `/api/*`
 *     route work unchanged. The browser sends it automatically.
 *   - a bearer access token + the raw `initData` — held in module memory only,
 *     for the `/api/v1/*` FastAPI routes (quant, tradeway) the page calls
 *     directly through Caddy. Neither is written to storage: initData is a
 *     replayable credential for 24h, and localStorage outlives the webview.
 *
 * The access token expires (60 min) long before initData does, so a 401 on a
 * `/api/v1/*` call re-logs-in once and retries — silently, because the user
 * has no way to "log in again" inside a Mini App.
 */

// The `window.Telegram.WebApp` shape is declared once, in
// `@/lib/telegram/mini-app` — importing the type here rather than re-declaring
// it keeps the two from drifting (Sprint 5 folded the Mini App into the one
// route tree, and two partial declarations of the same global is how the
// adapter and this module would come to disagree about what the SDK offers).
import "@/lib/telegram/mini-app";

export interface TelegramMiniUser {
  id: number | null;
  firstName: string | null;
  username: string | null;
}

export interface MiniAppLogin {
  user: { id: string; email: string; displayName: string };
  accessToken: string;
  telegramUser: TelegramMiniUser;
}

let accessToken: string | null = null;
let initData = "";

export function getInitData(): string {
  return initData;
}

/** Reads `window.Telegram.WebApp.initData`; "" outside a Telegram webview. */
export function readTelegramInitData(): string {
  if (typeof window === "undefined") return "";
  const tg = window.Telegram?.WebApp;
  return tg?.initData ?? "";
}

export async function telegramLogin(data: string): Promise<MiniAppLogin> {
  const res = await fetch("/api/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: data }),
  });
  const payload = (await res.json().catch(() => null)) as
    (MiniAppLogin & { error?: string }) | null;
  if (!res.ok || !payload?.accessToken) {
    throw new Error(payload?.error ?? `login failed (${res.status})`);
  }
  initData = data;
  accessToken = payload.accessToken;
  return payload;
}

/** Fetch against the FastAPI plane with the bearer token + initData attached. */
export async function apiV1Fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(initData ? { "x-telegram-init-data": initData } : {}),
      },
    });

  let res = await send();
  if (res.status === 401 && initData) {
    try {
      await telegramLogin(initData);
    } catch {
      return res; // re-login failed too — let the caller render the 401
    }
    res = await send();
  }
  return res;
}

export async function apiV1Json<T>(path: string): Promise<T> {
  const res = await apiV1Fetch(path);
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `request failed (${res.status})`);
  }
  if (body === null) throw new Error("empty response");
  return body;
}
