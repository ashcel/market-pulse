import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

/**
 * The signed-in user as seen by the **server**, callable from route
 * `beforeLoad` so a guard resolves during SSR instead of flashing protected
 * chrome and redirecting after hydration.
 *
 * The handler body is stripped from the client bundle by the Start plugin, so
 * the `@/server/**` import below (and the `postgres` client it reaches) never
 * ships to the browser — the same contract every other server function in
 * `lib/engine/` relies on. Verified by grepping the built client output.
 */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export const fetchSessionUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUser | null> => {
    const { getAuth } = await import("@/server/auth/session");
    const auth = await getAuth(getRequest());
    if (!auth) return null;
    return {
      id: auth.user.id,
      email: auth.user.email,
      displayName: auth.user.displayName,
      isAdmin: auth.user.isAdmin,
    };
  },
);
