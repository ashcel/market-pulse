import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { NotificationEvent } from "@/lib/engine/notifications";

export type BrowserPermission = "default" | "granted" | "denied" | "unsupported";

function currentPermission(): BrowserPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as BrowserPermission;
}

interface NotificationsState {
  items: NotificationEvent[];
  unreadCount: number;
  permission: BrowserPermission;
  add: (event: NotificationEvent) => void;
  markAllRead: () => void;
  requestPermission: () => Promise<BrowserPermission>;
}

const MAX_ITEMS = 30;

export const useNotificationsStore = create<NotificationsState>()(
  persist(
    (set, get) => ({
      items: [],
      unreadCount: 0,
      permission: currentPermission(),
      add: (event) => {
        if (get().items.some((item) => item.id === event.id)) return;
        set((s) => ({
          items: [event, ...s.items].slice(0, MAX_ITEMS),
          unreadCount: s.unreadCount + 1,
        }));
      },
      markAllRead: () => set({ unreadCount: 0 }),
      requestPermission: async () => {
        if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
        const result = (await Notification.requestPermission()) as BrowserPermission;
        set({ permission: result });
        return result;
      },
    }),
    {
      name: "iq-notifications",
      partialize: (s) => ({ items: s.items }),
    },
  ),
);
