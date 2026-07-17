import { createFileRoute } from "@tanstack/react-router";

import { assembleExternalContext, contextHealth } from "@/server/external-context/service";

/**
 * External market context — secondary evidence for the AI analyst.
 *
 *   GET ?symbol=SOL   → assembled context for one token (public — market-plane
 *                       data with no user content, like /api/token-events)
 *   GET ?view=health  → per-source ingest state + breadth snapshot age; never
 *                       "ok" while a configured source is failing or stale
 *
 * Serving is deliberately non-blocking: any internal failure still answers 200
 * with the failed sections null and `degradation` populated, so the token page
 * and the deterministic memo are never held hostage by this plane.
 */
export const Route = createFileRoute("/api/external-context")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);

        if (url.searchParams.get("view") === "health") {
          return Response.json(await contextHealth());
        }

        const symbol = url.searchParams.get("symbol");
        if (!symbol || !/^[A-Z0-9]{1,12}$/i.test(symbol.trim())) {
          return Response.json({ error: "missing or invalid symbol" }, { status: 400 });
        }
        try {
          return Response.json(await assembleExternalContext(symbol));
        } catch (err) {
          // Assembly already degrades per-section; reaching here means even the
          // shell failed — still answer shaped, still observable.
          return Response.json({
            symbol: symbol.trim().toUpperCase(),
            assembledAt: new Date().toISOString(),
            breadth: null,
            relative: null,
            recentCatalysts: null,
            recentHighImpact: null,
            upcoming: null,
            marketEvents: null,
            social: null,
            degradation: [{ section: "breadth", status: "error", reason: (err as Error).message }],
          });
        }
      },
    },
  },
});
