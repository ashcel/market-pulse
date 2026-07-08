import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

import type { NotificationEvent } from "@/lib/engine/notifications";
import { presentNotification } from "@/lib/notifications/present";
import { usePreferencesStore } from "@/stores/preferences";
import { useNotificationsStore } from "@/stores/notifications";

function isAllowed(
  event: NotificationEvent,
  prefs: { regime: boolean; rotation: boolean; highQualitySetup: boolean },
): boolean {
  return event.type === "setup-found" ? prefs.highQualitySetup : prefs.regime || prefs.rotation;
}

/** Opens the SSE notification stream for the app's lifetime and surfaces allowed events as
 * browser Notifications (when granted and the tab is hidden) or in-app toasts otherwise. */
export function useNotificationStream() {
  const router = useRouter();
  const add = useNotificationsStore((s) => s.add);
  const notifPrefs = usePreferencesStore((s) => s.notifications);
  const prefsRef = useRef(notifPrefs);
  prefsRef.current = notifPrefs;

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    const connectedAt = new Date().toISOString();
    const source = new EventSource("/api/notifications");

    const handle = (raw: MessageEvent<string>) => {
      let event: NotificationEvent;
      try {
        event = JSON.parse(raw.data) as NotificationEvent;
      } catch {
        return;
      }
      add(event);

      const isLive = event.createdAt > connectedAt;
      if (!isLive || !isAllowed(event, prefsRef.current)) return;

      presentNotification(event, () =>
        event.ticker
          ? router.navigate({ to: "/token/$symbol", params: { symbol: event.ticker } })
          : router.navigate({ to: "/regime" }),
      );
    };

    source.addEventListener("bias-summary", handle);
    source.addEventListener("setup-found", handle);

    return () => {
      source.close();
    };
  }, [add, router]);
}
