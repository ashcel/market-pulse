import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { HeldVerdict } from "@/lib/engine/hysteresis";

// Keep the persisted map bounded across many visited tokens: oldest holds are
// dropped first — a hold that old would be released as stale anyway.
const MAX_HOLDS = 160;

interface VerdictHoldsState {
  /** Keyed by `holdKey(symbol, market, intent)`. */
  holds: Record<string, HeldVerdict>;
  applyHolds: (updates: Record<string, HeldVerdict>) => void;
}

export const useVerdictHoldsStore = create<VerdictHoldsState>()(
  persist(
    (set) => ({
      holds: {},
      applyHolds: (updates) =>
        set((s) => {
          const merged = { ...s.holds, ...updates };
          const keys = Object.keys(merged);
          if (keys.length > MAX_HOLDS) {
            keys
              .sort((a, b) => Date.parse(merged[a].heldAt) - Date.parse(merged[b].heldAt))
              .slice(0, keys.length - MAX_HOLDS)
              .forEach((key) => delete merged[key]);
          }
          return { holds: merged };
        }),
    }),
    { name: "iq-verdict-holds" },
  ),
);
