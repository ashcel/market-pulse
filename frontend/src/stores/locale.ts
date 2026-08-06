import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Locale = "en" | "id";

export function sanitizeLocale(value: unknown): Locale {
  return value === "id" ? "id" : "en";
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/** Client-only locale preference (EN/ID). Not synced to the server — a per-device choice,
 * same pattern as `usePreferencesStore`. `src/lib/i18n/index.ts` mirrors this into i18next. */
export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      locale: "en",
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: "iq-locale",
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<LocaleState>;
        return { ...current, locale: sanitizeLocale(stored.locale) };
      },
    },
  ),
);
