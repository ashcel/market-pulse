import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PreferencesState {
  refreshIntervalMs: number;
  activeAsset: string;
  notifications: {
    regime: boolean;
    rotation: boolean;
    highImpactNews: boolean;
  };
  setRefreshInterval: (ms: number) => void;
  setActiveAsset: (ticker: string) => void;
  toggleNotification: (key: keyof PreferencesState["notifications"]) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      refreshIntervalMs: 30_000,
      activeAsset: "BTC",
      notifications: { regime: true, rotation: true, highImpactNews: true },
      setRefreshInterval: (ms) => set({ refreshIntervalMs: ms }),
      setActiveAsset: (ticker) => set({ activeAsset: ticker }),
      toggleNotification: (key) =>
        set((s) => ({
          notifications: { ...s.notifications, [key]: !s.notifications[key] },
        })),
    }),
    { name: "iq-preferences" },
  ),
);
