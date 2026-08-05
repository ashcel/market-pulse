import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light";

interface UiState {
  theme: Theme;
  sidebarOpen: boolean;
  /** The BYOK analyst panel. Lives here so any surface can open it. */
  askAiOpen: boolean;
  toggleTheme: () => void;
  setSidebar: (open: boolean) => void;
  setAskAi: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      sidebarOpen: true,
      askAiOpen: true,
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setSidebar: (open) => set({ sidebarOpen: open }),
      setAskAi: (open) => set({ askAiOpen: open }),
    }),
    { name: "iq-ui", partialize: (s) => ({ theme: s.theme, sidebarOpen: s.sidebarOpen }) },
  ),
);
