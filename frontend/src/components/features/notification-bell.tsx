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
import { useAlerts, useMarkAlertRead, useMarkAllAlertsRead } from "@/hooks/useAlerts";
import type { DecisionAlert } from "@/hooks/useAlerts";
import { cn } from "@/lib/utils";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function NotificationBell() {
  const navigate = useNavigate();
  const { data } = useAlerts();
  const markRead = useMarkAlertRead();
  const markAllRead = useMarkAllAlertsRead();
  const items = data?.data ?? [];
  const unreadCount = items.filter((item) => !item.read).length;

  const goTo = (alert: DecisionAlert) => {
    if (!alert.read) markRead.mutate(alert.id);
    if (alert.token_symbol) {
      navigate({ to: "/token/$symbol", params: { symbol: alert.token_symbol } });
    } else navigate({ to: "/markets", search: { tab: "regime" } });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-info px-1 text-center text-[9px] font-semibold text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Decision alerts</span>
          {unreadCount > 0 && (
            <button
              className="text-[11px] font-normal text-info hover:underline"
              onClick={(event) => {
                event.preventDefault();
                markAllRead.mutate();
              }}
            >
              Mark all read
            </button>
          )}
        </DropdownMenuLabel>
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
                    event.severity === "info" && "text-info",
                    event.severity === "warning" && "text-warning",
                    event.severity === "critical" && "text-bearish",
                    event.read && "opacity-60",
                )}
              >
                {event.title}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                 {relativeTime(event.created_at)}
              </span>
            </div>
            <span className="line-clamp-2 text-xs text-muted-foreground">{event.body}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
