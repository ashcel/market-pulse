import { createFileRoute } from "@tanstack/react-router";

import {
  clearedSessionCookie,
  getAuth,
  isResponse,
  readCookie,
  requireAuth,
  SESSION_COOKIE,
  sessionCookie,
} from "@/server/auth/session";
import {
  consumeLoginToken,
  createSession,
  getUserByEmail,
  redeemInvite,
  revokeSession,
} from "@/server/auth/store";

/**
 * Auth for the web tier. Sessions stay cookie-based; **password truth lives
 * in FastAPI** (users.hashed_password, bcrypt) — the web tier verifies
 * credentials by calling /api/v1/auth server-side and only then mints its
 * session cookie.
 *   GET                → the current user (or { user: null })
 *   POST { action }    → password-login | change-password |
 *                        redeem an invite | login with a link token | logout
 */

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";
export const Route = createFileRoute("/api/auth")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await getAuth(request);
        return Response.json({ user: auth?.user ?? null });
      },
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }
        const action = body.action;

        try {
          if (action === "password-login") {
            const email = String(body.email ?? "").trim();
            const password = String(body.password ?? "");
            if (!email || !password) {
              return Response.json({ error: "email and password required" }, { status: 400 });
            }
            // FastAPI is the single verifier — a 200 here proves the bcrypt
            // hash matched. The token it returns is discarded; the web tier's
            // own session cookie is the credential everything else reads.
            const verify = await fetch(`${BACKEND_BASE}/api/v1/auth/login`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email, password }),
            });
            if (!verify.ok) {
              return Response.json({ error: "invalid email or password" }, { status: 401 });
            }
            const user = await getUserByEmail(email);
            if (!user) return Response.json({ error: "unknown user" }, { status: 401 });
            const session = await createSession(user.id, str(body.deviceLabel));
            return withCookie({ user }, sessionCookie(session));
          }

          if (action === "change-password") {
            const auth = await requireAuth(request);
            if (isResponse(auth)) return auth;
            const res = await fetch(`${BACKEND_BASE}/api/v1/auth/change-password`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-internal-key": INTERNAL_KEY,
                "x-internal-user-id": auth.user.id,
              },
              body: JSON.stringify({
                current_password: String(body.currentPassword ?? ""),
                new_password: String(body.newPassword ?? ""),
              }),
            });
            if (!res.ok) {
              const message =
                res.status === 401 || res.status === 400
                  ? "current password incorrect"
                  : res.status === 422
                    ? "new password must be at least 8 characters"
                    : "could not change password";
              return Response.json({ error: message }, { status: res.status });
            }
            return Response.json({ ok: true });
          }

          if (action === "redeem") {
            const user = await redeemInvite(String(body.token ?? ""), {
              email: String(body.email ?? ""),
              displayName: String(body.displayName ?? "Tester"),
            });
            const session = await createSession(user.id, str(body.deviceLabel));
            return withCookie({ user }, sessionCookie(session));
          }

          if (action === "login") {
            const userId = await consumeLoginToken(String(body.token ?? ""));
            if (!userId)
              return Response.json({ error: "invalid or expired token" }, { status: 401 });
            const session = await createSession(userId, str(body.deviceLabel));
            return withCookie({ ok: true }, sessionCookie(session));
          }

          if (action === "logout") {
            const token = readCookie(request, SESSION_COOKIE);
            if (token) await revokeSession(token);
            return withCookie({ ok: true }, clearedSessionCookie());
          }

          return Response.json({ error: "unknown action" }, { status: 400 });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
      },
    },
  },
});

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function withCookie(payload: unknown, cookie: string): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  });
}
