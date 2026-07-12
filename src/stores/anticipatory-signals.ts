import { create } from "zustand";
import { persist } from "zustand/middleware";

import { isOpenAnticipatoryStatus } from "@/lib/engine/anticipatory";
import type { AnticipatorySignal } from "@/lib/engine/anticipatory";

export type AnticipatoryOpenInput = Omit<AnticipatorySignal, "id" | "status">;

// Bound the persisted record; settled entries beyond the cap age out oldest
// first so the record always rests on the most recent engine behavior.
const MAX_ANTICIPATORY_SIGNALS = 300;

interface AnticipatorySignalsState {
  signals: AnticipatorySignal[];
  /**
   * Records an anticipatory plan at adoption; ignored while the same
   * symbol/market/intent record is still open (pending or filled) — a
   * resting limit stays where it was placed (EDR 0010).
   */
  open: (input: AnticipatoryOpenInput) => void;
  applyPatch: (id: string, patch: Partial<AnticipatorySignal>) => void;
}

export const useAnticipatorySignalsStore = create<AnticipatorySignalsState>()(
  persist(
    (set, get) => ({
      signals: [],
      open: (input) => {
        const duplicate = get().signals.some(
          (s) =>
            isOpenAnticipatoryStatus(s.status) &&
            s.symbol === input.symbol &&
            s.market === input.market &&
            s.intent === input.intent,
        );
        if (duplicate) return;
        set((s) => {
          const signals = [
            { ...input, id: crypto.randomUUID(), status: "pending" as const },
            ...s.signals,
          ];
          if (signals.length > MAX_ANTICIPATORY_SIGNALS) {
            for (
              let i = signals.length - 1;
              i >= 0 && signals.length > MAX_ANTICIPATORY_SIGNALS;
              i--
            ) {
              if (!isOpenAnticipatoryStatus(signals[i].status)) signals.splice(i, 1);
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
      name: "iq-anticipatory-signals",
      // v1 (WS5 cutover): the browser no longer opens these records — the
      // autonomous worker is the sole writer. Bumping with no `migrate`
      // discards the old client-accumulated record (unversioned, biased —
      // it only ever saw symbols a tester happened to have open) rather than
      // reading it back as if it were still authoritative.
      version: 1,
    },
  ),
);
