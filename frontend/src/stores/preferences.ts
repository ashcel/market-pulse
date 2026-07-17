import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { TradingIntent } from "@/lib/engine/intent";
import type { StopMethod } from "@/lib/engine/quant";
import type { MarketType } from "@/lib/engine/binance";
import { clampLeverage } from "@/lib/utils/leverage";

export interface RiskPreferences {
  accountSize: number;
  maxRiskPerTradePercent: number;
  minimumRewardRisk: number;
  stopMethod: StopMethod;
}

/** Toggleable overlays on the token detail chart. */
export type ChartIndicatorKey =
  | "volume"
  | "emaFast"
  | "emaSlow"
  | "support"
  | "resistance"
  | "pivots"
  | "plan"
  | "zones"
  | "sdZones"
  | "sessions"
  | "liquidity";

interface PreferencesState {
  refreshIntervalMs: number;
  activeAsset: string;
  notifications: {
    regime: boolean;
    rotation: boolean;
    highImpactNews: boolean;
    highQualitySetup: boolean;
    /** Alert when a held verdict's own trigger level breaks on a closed candle. */
    triggerAlert: boolean;
    /** Market-wide discovery: a vertical spike on abnormal volume, immediately rejected. */
    spikeAlert: boolean;
  };
  risk: RiskPreferences;
  /** The trader's current objective — drives the token-page decision assistant. */
  tradingIntent: TradingIntent;
  /** Price the token page against Binance spot or perpetual futures. */
  marketType: MarketType;
  /** Leverage for perpetual position sizing (margin + liquidation display). */
  leverage: number;
  hiddenChartIndicators: Partial<Record<ChartIndicatorKey, boolean>>;
  setRefreshInterval: (ms: number) => void;
  setActiveAsset: (ticker: string) => void;
  toggleNotification: (key: keyof PreferencesState["notifications"]) => void;
  setRisk: (patch: Partial<RiskPreferences>) => void;
  setTradingIntent: (intent: TradingIntent) => void;
  setMarketType: (market: MarketType) => void;
  setLeverage: (leverage: number) => void;
  toggleChartIndicator: (key: ChartIndicatorKey) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      refreshIntervalMs: 30_000,
      activeAsset: "BTC",
      notifications: {
        regime: true,
        rotation: true,
        highImpactNews: true,
        highQualitySetup: true,
        triggerAlert: true,
        spikeAlert: true,
      },
      risk: {
        accountSize: 10_000,
        maxRiskPerTradePercent: 0.5,
        minimumRewardRisk: 1.6,
        stopMethod: "swing",
      },
      tradingIntent: "swing",
      marketType: "spot",
      leverage: 5,
      hiddenChartIndicators: {},
      setRefreshInterval: (ms) => set({ refreshIntervalMs: ms }),
      setActiveAsset: (ticker) => set({ activeAsset: ticker }),
      toggleNotification: (key) =>
        set((s) => ({
          notifications: { ...s.notifications, [key]: !s.notifications[key] },
        })),
      setRisk: (patch) => set((s) => ({ risk: { ...s.risk, ...patch } })),
      setTradingIntent: (intent) => set({ tradingIntent: intent }),
      setMarketType: (marketType) => set({ marketType }),
      setLeverage: (leverage) => set({ leverage: clampLeverage(leverage) }),
      toggleChartIndicator: (key) =>
        set((s) => ({
          hiddenChartIndicators: {
            ...s.hiddenChartIndicators,
            [key]: !s.hiddenChartIndicators[key],
          },
        })),
    }),
    {
      name: "iq-preferences",
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<PreferencesState>;
        return {
          ...current,
          ...stored,
          marketType: stored.marketType === "perp" ? "perp" : "spot",
          leverage: clampLeverage(
            typeof stored.leverage === "number" ? stored.leverage : current.leverage,
          ),
          notifications: { ...current.notifications, ...stored.notifications },
          risk: { ...current.risk, ...stored.risk },
          hiddenChartIndicators: {
            ...current.hiddenChartIndicators,
            ...stored.hiddenChartIndicators,
          },
        };
      },
    },
  ),
);
