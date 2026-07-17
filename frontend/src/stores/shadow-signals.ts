import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ShadowSignal } from "@/lib/engine/shadow";

export type ShadowOpenInput = Omit<ShadowSignal, "id" | "status">;

// Bound the persisted record; settled entries beyond the cap age out oldest
// first so the live stats always rest on the most recent engine behavior.
const MAX_SHADOW_SIGNALS = 300;

interface ShadowSignalsState {
  signals: ShadowSignal[];
  /** Records a favored verdict; ignored while the same symbol/market/intent call is still open. */
  open: (input: ShadowOpenInput) => void;
  applyPatch: (id: string, patch: Partial<ShadowSignal>) => void;
}

export const useShadowSignalsStore = create<ShadowSignalsState>()(
  persist(
    (set, get) => ({
      signals: [],
      open: (input) => {
        const duplicate = get().signals.some(
          (s) =>
            s.status === "active" &&
            s.symbol === input.symbol &&
            s.market === input.market &&
            s.intent === input.intent,
        );
        if (duplicate) return;
        set((s) => {
          const signals = [
            { ...input, id: crypto.randomUUID(), status: "active" as const },
            ...s.signals,
          ];
          if (signals.length > MAX_SHADOW_SIGNALS) {
            for (let i = signals.length - 1; i >= 0 && signals.length > MAX_SHADOW_SIGNALS; i--) {
              if (signals[i].status !== "active") signals.splice(i, 1);
            }
          }
          return { signals };
        });
      },
      applyPatch: (id, patch) =>
        set((s) => ({
          signals: s.signals.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        })),
    }),
    {
      name: "iq-shadow-signals",
      // v1 (WS5 cutover): the browser no longer opens these records — the
      // autonomous worker is the sole writer. Bumping with no `migrate`
      // discards the old client-accumulated record (unversioned, biased —
      // it only ever saw symbols a tester happened to have open) rather than
      // reading it back as if it were still authoritative.
      version: 1,
    },
  ),
);
