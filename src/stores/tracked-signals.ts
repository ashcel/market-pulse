import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { TrackedSignal } from "@/lib/engine/tracker";

/**
 * Offline/instant-paint cache of the user's followed signals (P1.1). The
 * system of record is Postgres — follows are POSTed to `/api/forward-test`
 * and settled by the worker; `useTrackedFollows` mirrors the last server
 * payload here so the tracker page can paint before the query resolves.
 *
 * This store never mutates records on its own anymore: no local follow(),
 * price updates, or settlement — those pretended an authority the browser
 * no longer has.
 */
interface TrackedSignalsState {
  signals: TrackedSignal[];
  /** Replace the cache with the server's list (called by useTrackedFollows). */
  setAll: (signals: TrackedSignal[]) => void;
}

export const useTrackedSignalsStore = create<TrackedSignalsState>()(
  persist(
    (set) => ({
      signals: [],
      setAll: (signals) => set({ signals }),
    }),
    {
      name: "iq-tracked-signals",
      // v1: server-owned follows. The unversioned v0 records were local-only
      // (they never reached the backend and lost their settlement path at the
      // WS5 cutover) — discard rather than merge them back in as if real.
      version: 1,
    },
  ),
);
