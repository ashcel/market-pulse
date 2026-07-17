import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";
import {
  deleteTrackedByOwner,
  followTracked,
  listTrackedByOwner,
  type FollowInput,
} from "@/server/db/repo";
import { forwardTestStats, healthSnapshot, recentRuns } from "@/server/forward-test/service";

/**
 * Auth-gated forward-test API (Phase B′). All handlers run behind the session
 * cookie except `?view=health`, which is deliberately public — it's the
 * worker's liveness check (WS4: "observable without SSH"), meant for curl /
 * uptime monitoring, and exposes only run status + open-record counts, never
 * user data. The engine's shadow-record stats are global (the shared track
 * record every tester evaluates); `follows` and `POST` are scoped to the
 * session user.
 *
 *   GET    ?view=stats   (default) → global shadow record stats for this engine
 *          ?view=runs             → recent scheduled evaluation passes
 *          ?view=health           → last run age/status + open-record counts (no auth)
 *          ?view=follows          → the current user's tracked signals
 *   POST                          → follow a call (owned by the session user)
 *   DELETE ?id=<uuid>             → remove one of the user's own follows
 */
export const Route = createFileRoute("/api/forward-test")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const view = new URL(request.url).searchParams.get("view") ?? "stats";
        if (view === "health") return Response.json(await healthSnapshot());

        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        if (view === "runs") return Response.json(await recentRuns());
        if (view === "follows") return Response.json(await listTrackedByOwner(auth.user.id));
        return Response.json(await forwardTestStats());
      },
      POST: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        let input: FollowInput;
        try {
          input = (await request.json()) as FollowInput;
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }
        const id = await followTracked(auth.user.id, auth.sessionToken, input);
        return Response.json({ id });
      },
      DELETE: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const id = new URL(request.url).searchParams.get("id");
        if (!id) return Response.json({ error: "missing id" }, { status: 400 });
        const removed = await deleteTrackedByOwner(auth.user.id, id);
        if (!removed) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ ok: true });
      },
    },
  },
});
