import { createFileRoute } from "@tanstack/react-router";

import { sessionCookie } from "@/server/auth/session";
import { createSession, getUserById } from "@/server/auth/store";
import { verifyInitData } from "@/server/telegram";

/**
 * Telegram Mini App login for the web tier.
 *
 *   POST { initData } → validates the signature here, has FastAPI validate it
 *   again and mint the access token, then sets the ordinary `mp_session`
 *   cookie for the owner's user row.
 *
 * Two credentials come back out of one call because the Mini App needs both:
 * the cookie makes every existing `/api/*` web-tier route work unchanged, and
 * the bearer token lets the page call `/api/v1/*` (FastAPI, via Caddy)
 * directly — the quant + positions proxies live there. The token is kept in
 * page memory only; it is never persisted.
 *
 * Rejection reasons stay server-side; the client only ever sees "unauthorized".
 */

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

export const Route = createFileRoute("/api/auth/telegram")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }

        const initData = String(body.initData ?? "");
        if (!initData) return Response.json({ error: "initData required" }, { status: 400 });

        const check = verifyInitData(initData);
        if (!check.ok) {
          console.warn(`[telegram-auth] rejected: ${check.reason}`);
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        // FastAPI holds the owner mapping (TELEGRAM_OWNER_USER_ID) and mints
        // the access token, so it re-verifies and stays the single issuer.
        let res: Response;
        try {
          res = await fetch(`${BACKEND_BASE}/api/v1/auth/telegram`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ initData }),
          });
        } catch (err) {
          return Response.json(
            { error: "backend unavailable", detail: (err as Error).message },
            { status: 502 },
          );
        }

        const payload = (await res.json().catch(() => null)) as {
          data?: { access_token?: string; user_id?: string; telegram_first_name?: string | null };
          error?: { message?: string };
        } | null;

        if (!res.ok) {
          // 503 = the owner mapping isn't configured yet; surface that one, it
          // is an operator problem rather than a failed credential.
          const message =
            res.status === 503
              ? (payload?.error?.message ?? "telegram login not configured")
              : "unauthorized";
          return Response.json({ error: message }, { status: res.status === 503 ? 503 : 401 });
        }

        const userId = payload?.data?.user_id;
        const accessToken = payload?.data?.access_token;
        if (!userId || !accessToken) {
          return Response.json({ error: "backend returned no session" }, { status: 502 });
        }

        const user = await getUserById(userId);
        if (!user) return Response.json({ error: "unknown user" }, { status: 401 });

        const session = await createSession(user.id, "telegram-mini-app");
        return new Response(
          JSON.stringify({
            user,
            accessToken,
            telegramUser: {
              id: check.user?.id ?? null,
              firstName: check.user?.first_name ?? payload?.data?.telegram_first_name ?? null,
              username: check.user?.username ?? null,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": sessionCookie(session),
            },
          },
        );
      },
    },
  },
});
