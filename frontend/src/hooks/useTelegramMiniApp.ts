import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  getInitData,
  readTelegramInitData,
  telegramLogin,
} from "@/components/features/miniapp/api";
import {
  applySafeArea,
  applyTelegramTheme,
  getWebApp,
  isMiniApp,
  markMiniAppRoot,
  type TelegramWebApp,
} from "@/lib/telegram/mini-app";

/**
 * Mounts the Mini App adaptation on the one route tree (Sprint 5 task 6).
 *
 * Called once from `__root.tsx`. Outside Telegram every branch short-circuits,
 * so the web app pays a boolean for this.
 */
export function useTelegramMiniApp(): boolean {
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const canGoBack = useRouterState({ select: (state) => state.location.pathname !== "/" });
  const [active, setActive] = useState(false);

  // --- theme + viewport ---------------------------------------------------
  useEffect(() => {
    const tg = getWebApp();
    const inside = isMiniApp();
    setActive(inside);
    markMiniAppRoot(inside);
    if (!tg || !inside) return;

    tg.ready?.();
    tg.expand?.();
    // Without this a vertical drag inside a chart closes the Mini App instead
    // of panning — the gesture belongs to the page, not the client.
    tg.disableVerticalSwipes?.();
    applyTelegramTheme(tg);
    applySafeArea(tg);

    const onTheme = () => applyTelegramTheme(tg);
    const onViewport = () => applySafeArea(tg);
    tg.onEvent?.("themeChanged", onTheme);
    tg.onEvent?.("viewportChanged", onViewport);
    tg.onEvent?.("safeAreaChanged", onViewport);
    tg.onEvent?.("contentSafeAreaChanged", onViewport);

    return () => {
      tg.offEvent?.("themeChanged", onTheme);
      tg.offEvent?.("viewportChanged", onViewport);
      tg.offEvent?.("safeAreaChanged", onViewport);
      tg.offEvent?.("contentSafeAreaChanged", onViewport);
      markMiniAppRoot(false);
    };
  }, []);

  // --- session -------------------------------------------------------------
  // The retired `/app` shell did this login itself. Now that the Mini App is
  // the ordinary route tree, the exchange has to happen at the root or every
  // page would bounce to /login: initData is the only credential a webview
  // carries, and the user has no way to "log in again" inside Telegram.
  useEffect(() => {
    if (!active || getInitData()) return;
    const data = readTelegramInitData();
    if (!data) return;
    let cancelled = false;
    telegramLogin(data)
      .then(() => {
        // The cookie only reaches in-flight requests after this resolves, so
        // re-run the loaders that raced it.
        if (!cancelled) router.invalidate();
      })
      .catch((error: Error) => {
        // Deliberately quiet: an unauthorised webview should fall through to
        // the app's normal unauthenticated view, not a Telegram-specific
        // error screen that the web app has no equivalent of.
        console.warn(`[mini-app] login failed: ${error.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [active, router]);

  // --- native BackButton --------------------------------------------------
  useEffect(() => {
    const tg = getWebApp();
    const back = tg?.BackButton;
    if (!active || !back) return;

    // Home is the root of the tree: showing a back button there would offer to
    // leave the app, which is the client's own gesture, not ours.
    if (!canGoBack) {
      back.hide();
      return;
    }

    const onClick = () => {
      // `history.back()` rather than navigate("/"): a Mini App user's mental
      // model is a stack, and skipping to home would lose their place.
      if (window.history.length > 1) router.history.back();
      else router.navigate({ to: "/" });
    };
    back.onClick(onClick);
    back.show();
    return () => {
      back.offClick(onClick);
      back.hide();
    };
  }, [active, canGoBack, pathname, router]);

  return active;
}

/**
 * Offers the client's native MainButton to a page's primary action — the
 * Ticket's "place trade", for instance.
 *
 * The caller keeps its own in-page button: this is an *additional* affordance,
 * not a replacement, because the same component renders on the web where there
 * is no MainButton at all. Passing `enabled: false` greys the native button
 * rather than hiding it, so the user can see the action exists and is not yet
 * available — a button that vanishes reads as a bug.
 */
export function useTelegramMainButton(options: {
  text: string;
  onClick: () => void;
  visible?: boolean;
  enabled?: boolean;
  loading?: boolean;
}): void {
  const { text, onClick, visible = true, enabled = true, loading = false } = options;

  useEffect(() => {
    const tg: TelegramWebApp | undefined = getWebApp();
    const button = tg?.MainButton;
    if (!isMiniApp() || !button) return;

    if (!visible) {
      button.hide();
      return;
    }

    button.setText(text);
    if (enabled && !loading) button.enable();
    else button.disable();
    if (loading) button.showProgress?.(false);
    else button.hideProgress?.();

    button.onClick(onClick);
    button.show();

    return () => {
      button.offClick(onClick);
      button.hide();
      button.hideProgress?.();
    };
  }, [text, onClick, visible, enabled, loading]);
}
