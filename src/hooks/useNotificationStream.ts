import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import type { NotificationEvent } from "@/lib/engine/notifications";
import { presentNotification } from "@/lib/notifications/present";
import { usePreferencesStore } from "@/stores/preferences";
import { useNotificationsStore } from "@/stores/notifications";

function isAllowed(
  event: NotificationEvent,
  prefs: { regime: boolean; rotation: boolean; highQualitySetup: boolean },
): boolean {
  // Worker-health (ops alert), follow-settled (the user's own trade closing),
  // and token-event (unlock/security on a token the user holds or watches —
  // already relevance-filtered server-side) are always surfaced, independent
  // of market-notification prefs.
  if (
    event.type === "worker-health" ||
    event.type === "follow-settled" ||
    event.type === "token-event"
  ) {
    return true;
  }
  return event.type === "setup-found" ? prefs.highQualitySetup : prefs.regime || prefs.rotation;
}

/** Opens the SSE notification stream for the app's lifetime and surfaces allowed events as
 * browser Notifications (when granted and the tab is hidden) or in-app toasts otherwise. */
export function useNotificationStream() {
  const router = useRouter();
  const queryClient = useQueryClient();
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

      if (event.type === "follow-settled") {
        // The user's own record changed — refresh the tracker's list now
        // instead of waiting out the refetch interval.
        queryClient.invalidateQueries({ queryKey: ["forward-test-follows"] });
      }

      presentNotification(event, () => {
        if (event.type === "worker-health" || event.type === "follow-settled") {
          return router.navigate({ to: "/tracker" });
        }
        return event.ticker
          ? router.navigate({ to: "/token/$symbol", params: { symbol: event.ticker } })
          : router.navigate({ to: "/regime" });
      });
    };

    source.addEventListener("bias-summary", handle);
    source.addEventListener("setup-found", handle);
    source.addEventListener("worker-health", handle);
    source.addEventListener("follow-settled", handle);
    source.addEventListener("token-event", handle);

    return () => {
      source.close();
    };
  }, [add, router, queryClient]);
}
