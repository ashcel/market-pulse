import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";
import { getUserPreference, upsertUserPreference } from "@/server/db/repo";

/**
 * Server-side mirror of the cap-segment (big-cap vs small-cap) trading
 * preference, so it follows the user across devices. The zustand
 * "iq-preferences" store stays the offline source of truth — this is a sync
 * target the client reads once on load and writes to on every explicit
 * segment choice.
 *
 *   GET                    → { capSegment } for the caller (null if unset)
 *   PUT { capSegment }     → upsert the caller's choice
 */
export const Route = createFileRoute("/api/preferences")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        const row = await getUserPreference(auth.user.id);
        return Response.json({ capSegment: row?.capSegment ?? null });
      },
      PUT: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        let capSegment: unknown;
        try {
          capSegment = ((await request.json()) as { capSegment?: unknown }).capSegment;
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }
        if (capSegment !== "bigcap" && capSegment !== "smallcap") {
          return Response.json(
            { error: "capSegment must be 'bigcap' or 'smallcap'" },
            { status: 400 },
          );
        }
        await upsertUserPreference(auth.user.id, capSegment);
        return Response.json({ ok: true });
      },
    },
  },
});
