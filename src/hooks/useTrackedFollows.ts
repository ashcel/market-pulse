import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { currentProvenance } from "@/lib/engine/version";
import { useTrackedSignalsStore } from "@/stores/tracked-signals";
import type { TrackedSignal } from "@/lib/engine/tracker";

/** Mirrors the server's `FollowInput` (`@/server/db/repo`) without importing server code. */
export type FollowInput = Omit<
  TrackedSignal,
  "id" | "followedAt" | "status" | "engineVersion" | "configHash" | "gitSha"
>;

/** Thrown by the follow/unfollow mutations when there is no session. */
export class NotSignedInError extends Error {
  constructor() {
    super("Sign in to follow signals.");
    this.name = "NotSignedInError";
  }
}

export interface TrackedFollows {
  follows: TrackedSignal[];
  /** False when the server said 401 — the caller should offer sign-in. */
  authenticated: boolean;
}

const FOLLOWS_KEY = ["forward-test-follows"] as const;

async function fetchFollows(): Promise<TrackedFollows> {
  const res = await fetch("/api/forward-test?view=follows", { credentials: "same-origin" });
  if (res.status === 401) return { follows: [], authenticated: false };
  if (!res.ok) throw new Error(`follows fetch failed: ${res.status}`);
  return { follows: (await res.json()) as TrackedSignal[], authenticated: true };
}

/**
 * The user's followed signals, server-owned (P1.1 — follows live in Postgres
 * and are settled by the worker; the browser only reads). The zustand store is
 * kept in sync purely as an offline/instant-paint cache.
 */
export function useTrackedFollows() {
  const cached = useTrackedSignalsStore((s) => s.signals);
  const query = useQuery({
    queryKey: FOLLOWS_KEY,
    queryFn: async () => {
      const result = await fetchFollows();
      if (result.authenticated) useTrackedSignalsStore.getState().setAll(result.follows);
      return result;
    },
    // The worker settles on a 5m cadence; refetching each minute keeps the
    // tracker page's statuses close behind without hammering the API.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const data = query.data ?? { follows: cached, authenticated: true };
  return { ...query, follows: data.follows, authenticated: data.authenticated };
}

/** POST a follow to the server record. Rejects with NotSignedInError on 401. */
export function useFollowSignal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: FollowInput): Promise<string> => {
      const res = await fetch("/api/forward-test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, ...currentProvenance() }),
      });
      if (res.status === 401) throw new NotSignedInError();
      if (!res.ok) throw new Error(`follow failed: ${res.status}`);
      return ((await res.json()) as { id: string }).id;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: FOLLOWS_KEY }),
  });
}

/** Remove one of the user's own follows. */
export function useUnfollowSignal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/api/forward-test?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.status === 401) throw new NotSignedInError();
      if (!res.ok && res.status !== 404) throw new Error(`unfollow failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: FOLLOWS_KEY }),
  });
}
