import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";
import { trackToken } from "@/server/db/repo";

/**
 * Auto-track on open: the token page POSTs the symbol it's showing so the
 * Python unlock pass will fetch that token's unlock calendar (scope = universe
 * + starred + opened). The row itself is global rather than user-owned, but
 * this is still an unbounded INSERT driven by a request body — on a public
 * site that is an abuse vector, so it requires a session. An anonymous visitor
 * simply does not widen the unlock-fetch scope; the client already swallows
 * failures (fire-and-forget), so the page is unaffected.
 */
const TICKER_RE = /^[A-Z0-9]{1,20}$/;

export const Route = createFileRoute("/api/track-token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        let symbol: unknown;
        try {
          symbol = ((await request.json()) as { symbol?: unknown }).symbol;
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }
        if (typeof symbol !== "string") {
          return Response.json({ error: "symbol required" }, { status: 400 });
        }
        const ticker = symbol.toUpperCase();
        if (!TICKER_RE.test(ticker)) {
          return Response.json({ error: "invalid symbol" }, { status: 400 });
        }
        await trackToken(ticker);
        return Response.json({ ok: true });
      },
    },
  },
});
