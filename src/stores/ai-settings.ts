import { create } from "zustand";
import { persist } from "zustand/middleware";

import { PROVIDERS, type AiProvider } from "@/lib/ai/providers";

// BYOK AI-analyst configuration. API keys are persisted to localStorage so the
// user only enters them once; they are sent directly to the chosen provider
// from the browser and never to this app's server. Keys are stored per provider
// so switching providers doesn't wipe the others.
interface AiSettingsState {
  provider: AiProvider;
  apiKeys: Partial<Record<AiProvider, string>>;
  models: Partial<Record<AiProvider, string>>;
  customBaseUrl: string;
  setProvider: (provider: AiProvider) => void;
  setApiKey: (provider: AiProvider, key: string) => void;
  setModel: (provider: AiProvider, model: string) => void;
  setCustomBaseUrl: (url: string) => void;
  clearApiKey: (provider: AiProvider) => void;
}

export const useAiSettingsStore = create<AiSettingsState>()(
  persist(
    (set) => ({
      provider: "openrouter",
      apiKeys: {},
      models: {},
      customBaseUrl: "",
      setProvider: (provider) => set({ provider }),
      setApiKey: (provider, key) => set((s) => ({ apiKeys: { ...s.apiKeys, [provider]: key } })),
      setModel: (provider, model) => set((s) => ({ models: { ...s.models, [provider]: model } })),
      setCustomBaseUrl: (url) => set({ customBaseUrl: url }),
      clearApiKey: (provider) =>
        set((s) => {
          const apiKeys = { ...s.apiKeys };
          delete apiKeys[provider];
          return { apiKeys };
        }),
    }),
    {
      name: "iq-ai-settings",
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<AiSettingsState>;
        const provider =
          stored.provider && PROVIDERS[stored.provider] ? stored.provider : current.provider;
        return {
          ...current,
          ...stored,
          provider,
          apiKeys: { ...current.apiKeys, ...stored.apiKeys },
          models: { ...current.models, ...stored.models },
        };
      },
    },
  ),
);
