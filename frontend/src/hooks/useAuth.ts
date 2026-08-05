import { useCurrentUser } from "@/hooks/queries";

/**
 * Who is looking at the page. The market plane is public; the personal plane
 * (trades, tracker, review, alerts, watchlist, settings) is not, so every
 * component that renders user-scoped chrome asks here first.
 *
 * This governs **display only** — the guard in `lib/auth/guard.ts` and the
 * `requireAuth` check inside each API handler are what actually protect data.
 * `isPending` matters: while the session is still resolving, render neither
 * the signed-in nor the signed-out chrome, so a signed-in user never sees a
 * "Sign in" flash on reload.
 */
export function useAuth() {
  const query = useCurrentUser();
  return {
    user: query.data ?? null,
    isAuthed: !!query.data,
    isAnonymous: query.isFetched && !query.data,
    isPending: query.isPending,
  };
}
