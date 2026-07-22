import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { usePreferencesStore } from "@/stores/preferences";

/**
 * One-time bootstrap: adopt the server's cap-segment preference when the
 * local store hasn't got one yet. Never overrides a value the user already
 * has locally (including one they're mid-way through hand-tuning) — this is
 * a sync-in, not a sync-both-ways subscription. Writing the user's *choice*
 * back out happens explicitly via `putCapSegment`, called from the first-run
 * modal and Settings. Mounted once in the root layout, alongside
 * useWatchlistSync.
 */
export function usePreferencesSync() {
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      try {
        const res = await fetch("/api/preferences", { credentials: "same-origin" });
        if (!res.ok) return; // signed out (401) or transient — local stays authoritative
        const server = ((await res.json()) as { capSegment: "bigcap" | "smallcap" | null })
          .capSegment;
        if (!server) return;
        if (usePreferencesStore.getState().capSegment === null) {
          // Adopt the server value as-is — do NOT go through setCapSegment,
          // which would re-apply risk defaults over whatever the user has
          // already tuned locally.
          usePreferencesStore.setState({ capSegment: server });
        }
      } catch {
        // Offline — nothing to sync.
      }
    })();
  }, []);
}

/** PUT the user's explicit cap-segment choice to the server. Fire-and-forget:
 * the local store (already updated by setCapSegment) is the source of truth,
 * this just keeps the server mirror in sync for other devices. */
export function putCapSegment(segment: "bigcap" | "smallcap") {
  fetch("/api/preferences", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capSegment: segment }),
  })
    .then((res) => {
      if (!res.ok) throw new Error("request failed");
    })
    .catch(() => {
      toast.error("Couldn't save your trading focus to your account — it's saved on this device.");
    });
}
