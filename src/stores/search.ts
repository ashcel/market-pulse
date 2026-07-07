import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_RECENT = 5;

interface SearchState {
  recent: string[];
  addRecent: (ticker: string) => void;
  clearRecent: () => void;
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      recent: [],
      addRecent: (ticker) =>
        set((s) => ({
          recent: [ticker, ...s.recent.filter((t) => t !== ticker)].slice(0, MAX_RECENT),
        })),
      clearRecent: () => set({ recent: [] }),
    }),
    { name: "iq-search" },
  ),
);
