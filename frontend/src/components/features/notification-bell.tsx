import { Bell } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNotificationsStore } from "@/stores/notifications";
import type { NotificationEvent } from "@/lib/engine/notifications";
import { cn } from "@/lib/utils";
import { humanRelative } from "@/lib/time";

export function NotificationBell() {
  const navigate = useNavigate();
  const items = useNotificationsStore((s) => s.items);
  const unreadCount = useNotificationsStore((s) => s.unreadCount);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);

  const goTo = (event: NotificationEvent) => {
    if (event.ticker) navigate({ to: "/token/$symbol", params: { symbol: event.ticker } });
    else navigate({ to: "/regime" });
  };

  return (
    <DropdownMenu onOpenChange={(open) => open && markAllRead()}>
      <DropdownMenuTrigger asChild>
        <button
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-info" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            No notifications yet.
          </div>
        )}
        {items.slice(0, 8).map((event) => (
          <DropdownMenuItem
            key={event.id}
            onClick={() => goTo(event)}
            className="flex flex-col items-start gap-0.5 py-2"
          >
            <div className="flex w-full items-center justify-between gap-2">
              <span
                className={cn(
                  "text-sm font-medium",
                  event.type === "setup-found" && "text-bullish",
                  (event.type === "trigger-hit" || event.type === "follow-settled") && "text-info",
                  (event.type === "worker-health" || event.type === "token-event") &&
                    "text-warning",
                  event.type === "spike-alert" && "text-info",
                  event.type !== "setup-found" &&
                    event.type !== "trigger-hit" &&
                    event.type !== "follow-settled" &&
                    event.type !== "worker-health" &&
                    event.type !== "token-event" &&
                    event.type !== "spike-alert" &&
                    "text-foreground",
                )}
              >
                {event.title}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {humanRelative(event.createdAt)}
              </span>
            </div>
            <span className="line-clamp-2 text-xs text-muted-foreground">{event.body}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
