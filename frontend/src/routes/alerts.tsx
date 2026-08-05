import { createFileRoute, Link } from "@tanstack/react-router";
import { Bell, BellOff } from "lucide-react";
import { useMemo, useState } from "react";

import { IqCard } from "@/components/features/iq-card";
import { PageHeader } from "@/components/features/page-header";
import { StatusBadge } from "@/components/features/status-badge";
import { useNotificationsStore } from "@/stores/notifications";
import type { NotificationEvent } from "@/lib/engine/notifications";
import { cn } from "@/lib/utils";
import { humanRelative } from "@/lib/time";

/**
 * Alert history. The SSE stream (`useNotificationStream`, mounted at the root)
 * is the source; this page is the persisted log of what it delivered, plus the
 * browser-permission control. Nothing is generated here.
 */
export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — Market Pulse" },
      {
        name: "description",
        content: "Every alert delivered: setups found, triggers hit, token events, worker health.",
      },
    ],
  }),
  component: AlertsPage,
});

const TYPE_LABEL: Record<string, string> = {
  "setup-found": "Setup found",
  "trigger-hit": "Trigger hit",
  "follow-settled": "Follow settled",
  "worker-health": "Worker health",
  "token-event": "Token event",
  "spike-alert": "Spike alert",
};

function toneFor(type: string): "bullish" | "info" | "warning" | "neutral" {
  if (type === "setup-found") return "bullish";
  if (type === "trigger-hit" || type === "follow-settled" || type === "spike-alert") return "info";
  if (type === "worker-health" || type === "token-event") return "warning";
  return "neutral";
}

function AlertsPage() {
  const items = useNotificationsStore((s) => s.items);
  const permission = useNotificationsStore((s) => s.permission);
  const requestPermission = useNotificationsStore((s) => s.requestPermission);
  const [filter, setFilter] = useState<string>("all");

  const types = useMemo(() => [...new Set(items.map((i) => i.type))], [items]);
  const shown = items.filter((i) => filter === "all" || i.type === filter);

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <PageHeader
        eyebrow="Trading"
        title="Alerts"
        subtitle="Everything the notification stream has delivered to this browser."
        action={
          permission !== "granted" && permission !== "unsupported" ? (
            <button
              type="button"
              onClick={() => void requestPermission()}
              className="flex items-center gap-1.5 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-xs font-semibold text-info transition-colors hover:bg-info/20"
            >
              <Bell className="h-3.5 w-3.5" />
              Enable browser alerts
            </button>
          ) : null
        }
      />

      {types.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {["all", ...types].map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                filter === t
                  ? "border-info bg-info-soft text-info"
                  : "border-border bg-surface text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "all" ? "All" : (TYPE_LABEL[t] ?? t)}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <IqCard className="flex flex-col items-center py-12 text-center">
          <BellOff className="mb-3 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">No alerts yet.</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Alerts fire when the engine adopts a setup, a followed trigger hits, or a watched token
            gets a high-impact event. Add tokens to your{" "}
            <Link to="/watchlist" className="text-info hover:underline">
              watchlist
            </Link>{" "}
            to widen the net.
          </p>
        </IqCard>
      ) : (
        <IqCard padded={false}>
          <ul className="flex flex-col divide-y divide-border">
            {shown.map((event: NotificationEvent) => (
              <li key={event.id}>
                <AlertRow event={event} />
              </li>
            ))}
          </ul>
        </IqCard>
      )}
    </div>
  );
}

function AlertRow({ event }: { event: NotificationEvent }) {
  const inner = (
    <div className="flex flex-col gap-1 px-5 py-3 transition-colors hover:bg-surface/50">
      <div className="flex items-center gap-2">
        <StatusBadge tone={toneFor(event.type)}>{TYPE_LABEL[event.type] ?? event.type}</StatusBadge>
        {event.ticker && <span className="text-sm font-semibold">{event.ticker}</span>}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {humanRelative(event.createdAt)}
        </span>
      </div>
      <p className="text-sm font-medium">{event.title}</p>
      <p className="text-xs text-muted-foreground">{event.body}</p>
    </div>
  );
  return event.ticker ? (
    <Link to="/token/$symbol" params={{ symbol: event.ticker }} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}
