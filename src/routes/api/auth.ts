import { createFileRoute } from "@tanstack/react-router";

import {
  clearedSessionCookie,
  getAuth,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
} from "@/server/auth/session";
import { consumeLoginToken, createSession, redeemInvite, revokeSession } from "@/server/auth/store";

/**
 * Invite-only, passwordless auth (Phase B).
 *   GET                → the current user (or { user: null })
 *   POST { action }    → redeem an invite | login with a link token | logout
 */
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
