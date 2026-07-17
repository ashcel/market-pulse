import { toast } from "sonner";

import { useNotificationsStore } from "@/stores/notifications";
import type { NotificationEvent } from "@/lib/engine/notifications";

/**
 * Surfaces one notification event to the user: an OS notification when the tab
 * is hidden and permission is granted, otherwise an in-app toast. Shared by the
 * server SSE stream and the client-side trigger watcher so both alert paths
 * look and behave identically.
 */
export function presentNotification(event: NotificationEvent, onView: () => void): void {
  const permission = useNotificationsStore.getState().permission;
  if (
    permission === "granted" &&
    typeof document !== "undefined" &&
    document.visibilityState !== "visible"
  ) {
    new Notification(event.title, { body: event.body, tag: event.id });
    return;
  }

  toast(event.title, {
    description: event.body,
    action: { label: "View", onClick: onView },
  });
}
