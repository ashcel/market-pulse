import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";
import { forwardReturnEvidence } from "@/server/forward-test/evidence";

/**
 * Auth-gated read model over the `forward_return` ground-truth table — the
 * Track Record section on the Review page. Aggregate stats only (per
 * horizon: n, avg/median return, win rate, best/worst symbol) — never raw
 * rows.
 *
 *   GET (default) → per-horizon forward-return stats
 */
export const Route = createFileRoute("/api/evidence")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        return Response.json(await forwardReturnEvidence());
      },
    },
  },
});
