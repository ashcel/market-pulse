import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";
import { followTracked, listTrackedByOwner, type FollowInput } from "@/server/db/repo";
import { forwardTestStats, recentRuns } from "@/server/forward-test/service";

/**
 * Auth-gated forward-test API (Phase B′). All handlers run behind the session
 * cookie. The engine's shadow-record stats are global (the shared track record
 * every tester evaluates); `follows` and `POST` are scoped to the session user.
 *
 *   GET  ?view=stats   (default) → global shadow record stats for this engine
 *        ?view=runs             → recent scheduled evaluation passes
 *        ?view=follows          → the current user's tracked signals
 *   POST                        → follow a call (owned by the session user)
 */
export const Route = createFileRoute("/api/forward-test")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const view = new URL(request.url).searchParams.get("view") ?? "stats";
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
    },
  },
});
