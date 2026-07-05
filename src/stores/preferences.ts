import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { StopMethod } from "@/lib/engine/quant";

export interface RiskPreferences {
  accountSize: number;
  maxRiskPerTradePercent: number;
  minimumRewardRisk: number;
  stopMethod: StopMethod;
}

interface PreferencesState {
  refreshIntervalMs: number;
  activeAsset: string;
  notifications: {
    regime: boolean;
    rotation: boolean;
    highImpactNews: boolean;
  };
  risk: RiskPreferences;
  setRefreshInterval: (ms: number) => void;
  setActiveAsset: (ticker: string) => void;
  toggleNotification: (key: keyof PreferencesState["notifications"]) => void;
  setRisk: (patch: Partial<RiskPreferences>) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      refreshIntervalMs: 30_000,
      activeAsset: "BTC",
      notifications: { regime: true, rotation: true, highImpactNews: true },
      risk: {
        accountSize: 10_000,
        maxRiskPerTradePercent: 0.5,
        minimumRewardRisk: 1.6,
        stopMethod: "swing",
      },
      setRefreshInterval: (ms) => set({ refreshIntervalMs: ms }),
      setActiveAsset: (ticker) => set({ activeAsset: ticker }),
      toggleNotification: (key) =>
        set((s) => ({
          notifications: { ...s.notifications, [key]: !s.notifications[key] },
        })),
      setRisk: (patch) => set((s) => ({ risk: { ...s.risk, ...patch } })),
    }),
    {
      name: "iq-preferences",
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<PreferencesState>;
        return {
          ...current,
          ...stored,
          notifications: { ...current.notifications, ...stored.notifications },
          risk: { ...current.risk, ...stored.risk },
        };
      },
    },
  ),
);
