import { useUiStore } from "@/stores/ui";
import { useEffect } from "react";

/** Applies dark/light class to <html> based on Zustand ui store. Default dark. */
export function ThemeSync() {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
    root.style.colorScheme = theme;
  }, [theme]);
  return null;
}
