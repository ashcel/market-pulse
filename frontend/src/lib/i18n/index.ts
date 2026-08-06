import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import id from "./locales/id.json";

import type { Locale } from "@/stores/locale";

/** Module-level singleton, safe under SSR: one instance per server request process,
 * re-used across the client's lifetime. Default `en` — `LocaleSync` mirrors the
 * persisted `useLocaleStore` choice into it after hydration. */
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en }, id: { translation: id } },
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export function setI18nLocale(locale: Locale) {
  if (i18next.language !== locale) void i18next.changeLanguage(locale);
}

export { i18next };
