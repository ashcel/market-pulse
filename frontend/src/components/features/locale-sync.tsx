import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useLocaleStore, type Locale } from "@/stores/locale";
import { setI18nLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Mirrors the persisted locale store into the i18next instance, same pattern as `ThemeSync`. */
export function LocaleSync() {
  const locale = useLocaleStore((s) => s.locale);
  useEffect(() => {
    setI18nLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "id", label: "ID" },
];

/** Compact EN/ID toggle, same visual pattern as the spot/perp switch in `TopBar`. */
export function LocaleSwitcher() {
  const { t } = useTranslation();
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);

  return (
    <div
      className="hidden items-center rounded-md border border-border bg-surface p-0.5 text-xs sm:flex"
      aria-label={t("topBar.language")}
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => setLocale(opt.value)}
          className={cn(
            "h-8 rounded px-2.5 font-semibold transition-colors",
            locale === opt.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
