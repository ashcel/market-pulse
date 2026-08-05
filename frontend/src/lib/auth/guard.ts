import { redirect } from "@tanstack/react-router";

import { fetchSessionUser, type SessionUser } from "./session-fn";

/**
 * Route guard for the personal plane (trades, tracker, review, alerts,
 * watchlist, settings). Call from `beforeLoad` so the check resolves on the
 * server during SSR — an anonymous visitor is redirected before any protected
 * chrome renders.
 *
 * This is defence in depth, not the boundary: every API behind these pages
 * independently requires a session (`requireAuth`), so a guard that is somehow
 * bypassed still yields no data.
 */
export async function requireSession(pathname: string): Promise<SessionUser> {
  const user = await fetchSessionUser();
  if (!user) {
    throw redirect({ to: "/login", search: { redirect: pathname } });
  }
  return user;
}

/** Routes that require a session. Kept here so the list is auditable in one place. */
export const PROTECTED_ROUTES = [
  "/trades",
  "/tracker",
  "/review",
  "/alerts",
  "/watchlist",
  "/settings",
] as const;
