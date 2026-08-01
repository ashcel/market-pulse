import { redirect } from "@tanstack/react-router";

import { NAV_V2 } from "./flags";

/**
 * Where every retired route goes once the 4-tab nav is on
 * (docs/IMPLEMENTATION-PLAN.md §3 Sprint 5 task 4: "→ **redirect** ke rumah
 * barunya (bukan 404)").
 *
 * Two properties this table is written to guarantee:
 *
 * 1. **No orphans.** Every path that leaves the nav appears here, so a
 *    bookmark, a Telegram deep link or an old alert URL lands somewhere real
 *    instead of on the 404 component.
 * 2. **Single hop.** `/rankings` used to redirect to `/markets`, which itself
 *    now redirects; chaining two redirects through a route that no longer
 *    renders is how a redirect loop gets shipped. Under NAV_V2 each entry
 *    points at its *final* destination directly.
 *
 * Market context did not disappear — the 2026-07-24 direction correction put
 * the market strip and Top News on Now, and the single surviving "market
 * detail" surface is `/token/$symbol`, reached from Now. That is why the
 * former Markets planes all collapse to `/`.
 *
 * These are TanStack route redirects (client and SSR), never infra: no Caddy
 * rule is involved, and `NAV_V2=0` leaves every old route rendering exactly as
 * it does today — that is the sprint's one-line rollback.
 */
export const NAV_V2_REDIRECTS = {
  // Markets planes → Now (market context lives on the home strip + Top News)
  "/markets": "/",
  "/rankings": "/",
  "/regime": "/",
  "/rotation": "/",
  "/technical": "/",
  "/news": "/",
  // Decision history and trade review → Lab (evidence)
  "/journal": "/lab",
  "/review": "/lab",
  // Positions, followed signals → Book (what is at risk right now)
  "/tracker": "/book",
  "/trades": "/book",
  // The old standalone Mini App shell → one route tree
  "/app": "/",
} as const;

export type RetiredRoute = keyof typeof NAV_V2_REDIRECTS;

/**
 * Call from a route's `beforeLoad`. A no-op while `NAV_V2` is off, which is
 * what keeps the old routes alive during the two-week grace window the sprint
 * plan asks for before they are deleted for good.
 */
export function redirectIfNavV2(from: RetiredRoute): void {
  if (!NAV_V2) return;
  throw redirect({ to: NAV_V2_REDIRECTS[from], replace: true });
}
