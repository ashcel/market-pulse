import { createFileRoute } from "@tanstack/react-router";

import { trackToken } from "@/server/db/repo";

/**
 * Auto-track on open: the token page POSTs the symbol it's showing so the
 * Python unlock pass will fetch that token's unlock calendar (scope = universe
 * + starred + opened). No auth — this is a global, low-stakes fetch-scope hint,
 * not user data. Validated to a bare ticker; failures are swallowed client-side
 * (fire-and-forget), so a DB hiccup never affects the page.
 */
const TICKER_RE = /^[A-Z0-9]{1,20}$/;

export const Route = createFileRoute("/api/track-token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
