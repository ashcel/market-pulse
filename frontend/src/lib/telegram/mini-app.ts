/**
 * Telegram Mini App adapter (docs/IMPLEMENTATION-PLAN.md §3 Sprint 5 task 6).
 *
 * **One route tree.** The old `/app` shell was a second, parallel product: its
 * own tabs, its own components, its own idea of what the app is. It is retired
 * (see `lib/nav-redirects.ts`); inside Telegram the user now gets the ordinary
 * app, adapted rather than replaced. Anything added to the web app is in the
 * Mini App automatically, which was the whole reason for the merge.
 *
 * "Adapted" means four things and nothing more:
 *   1. Telegram's theme colours drive the app's CSS variables, so the webview
 *      does not look pasted into the client.
 *   2. The viewport's safe-area insets reach the layout — Telegram's own
 *      header/footer overlap a naive full-height page.
 *   3. The client's native BackButton drives the router, because a Mini App has
 *      no browser chrome to go back with.
 *   4. The native MainButton is offered to the primary action of whatever page
 *      is showing (the Ticket uses it), since a thumb reaching a sticky button
 *      inside the webview is worse than the client's own.
 *
 * Everything here degrades to a no-op outside Telegram: `isMiniApp()` is false,
 * the hooks return early, and the web app is byte-identically what it was.
 */

export interface TelegramThemeParams {
  bg_color?: string;
  secondary_bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  header_bg_color?: string;
  section_bg_color?: string;
}

export interface TelegramMainButton {
  text: string;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  showProgress?: (leaveActive?: boolean) => void;
  hideProgress?: () => void;
  setText: (text: string) => void;
  setParams?: (params: Record<string, unknown>) => void;
  onClick: (handler: () => void) => void;
  offClick: (handler: () => void) => void;
  isVisible?: boolean;
}

export interface TelegramBackButton {
  show: () => void;
  hide: () => void;
  onClick: (handler: () => void) => void;
  offClick: (handler: () => void) => void;
}

export interface TelegramWebApp {
  initData?: string;
  initDataUnsafe?: { user?: { id?: number; first_name?: string; username?: string } };
  ready?: () => void;
  expand?: () => void;
  colorScheme?: "light" | "dark" | string;
  themeParams?: TelegramThemeParams;
  viewportHeight?: number;
  viewportStableHeight?: number;
  safeAreaInset?: { top?: number; bottom?: number; left?: number; right?: number };
  contentSafeAreaInset?: { top?: number; bottom?: number; left?: number; right?: number };
  isExpanded?: boolean;
  platform?: string;
  version?: string;
  MainButton?: TelegramMainButton;
  BackButton?: TelegramBackButton;
  HapticFeedback?: { impactOccurred?: (style: string) => void };
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  disableVerticalSwipes?: () => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | undefined {
  if (typeof window === "undefined") return undefined;
  return window.Telegram?.WebApp;
}

/**
 * True only inside a real Telegram webview. The SDK script injects
 * `window.Telegram.WebApp` on any page that loads it, so the presence of the
 * object is NOT enough — `initData` is what a genuine client supplies.
 */
export function isMiniApp(): boolean {
  const tg = getWebApp();
  return Boolean(tg && typeof tg.initData === "string" && tg.initData.length > 0);
}

/**
 * Telegram theme → the app's CSS variables.
 *
 * Only the surface-level colours are mapped. Semantic colours (bullish,
 * bearish, warning) are deliberately left alone: a red that means "loss" must
 * not become whatever red the user's Telegram theme happens to use, and a
 * client theme that recoloured them would make a losing position unreadable.
 */
const THEME_VAR_MAP: [keyof TelegramThemeParams, string[]][] = [
  ["bg_color", ["--background"]],
  ["secondary_bg_color", ["--card", "--surface"]],
  ["section_bg_color", ["--sidebar"]],
  ["text_color", ["--foreground", "--card-foreground"]],
  ["hint_color", ["--muted-foreground"]],
  ["button_color", ["--primary"]],
  ["button_text_color", ["--primary-foreground"]],
];

export function applyTelegramTheme(tg: TelegramWebApp | undefined): void {
  if (!tg || typeof document === "undefined") return;
  const params = tg.themeParams;
  const root = document.documentElement;

  if (params) {
    for (const [key, vars] of THEME_VAR_MAP) {
      const value = params[key];
      if (!value) continue;
      for (const cssVar of vars) root.style.setProperty(cssVar, value);
    }
  }

  // Telegram renders its own header above the webview; matching it removes the
  // seam between client chrome and page.
  tg.setHeaderColor?.(params?.header_bg_color ?? params?.bg_color ?? "#0e1015");
  tg.setBackgroundColor?.(params?.bg_color ?? "#0e1015");

  if (tg.colorScheme === "light") {
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  } else {
    root.classList.add("dark");
    root.style.colorScheme = "dark";
  }
}

/**
 * Safe-area insets as CSS variables. `env(safe-area-inset-*)` is not enough
 * inside Telegram: the client's own header and the swipe-down handle sit over
 * the webview, and only the SDK knows how far.
 */
export function applySafeArea(tg: TelegramWebApp | undefined): void {
  if (!tg || typeof document === "undefined") return;
  const root = document.documentElement;
  const inset = tg.contentSafeAreaInset ?? tg.safeAreaInset ?? {};
  root.style.setProperty("--tg-safe-top", `${inset.top ?? 0}px`);
  root.style.setProperty("--tg-safe-bottom", `${inset.bottom ?? 0}px`);
  root.style.setProperty("--tg-safe-left", `${inset.left ?? 0}px`);
  root.style.setProperty("--tg-safe-right", `${inset.right ?? 0}px`);
  if (tg.viewportStableHeight) {
    root.style.setProperty("--tg-viewport-height", `${tg.viewportStableHeight}px`);
  }
}

/** Marks `<html>` so CSS can target the webview without a JS round trip. */
export function markMiniAppRoot(active: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("tg-mini-app", active);
}
