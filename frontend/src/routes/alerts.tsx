import { createFileRoute, Link } from "@tanstack/react-router";
import { Bell, BellOff } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { IqCard } from "@/components/features/iq-card";
import { PageHeader } from "@/components/features/page-header";
import { StatusBadge } from "@/components/features/status-badge";
import { useNotificationsStore } from "@/stores/notifications";
import type { NotificationEvent } from "@/lib/engine/notifications";
import { cn } from "@/lib/utils";
import { humanRelative } from "@/lib/time";
import { requireSession } from "@/lib/auth/guard";

/**
 * Alert history. The SSE stream (`useNotificationStream`, mounted at the root)
 * is the source; this page is the persisted log of what it delivered, plus the
 * browser-permission control. Nothing is generated here.
 */
export const Route = createFileRoute("/alerts")({
  beforeLoad: () => requireSession("/alerts"),
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

/** Keys under `alerts.*` — see `typeLabel`. */
const TYPE_LABEL_KEY: Record<string, string> = {
  "setup-found": "typeSetupFound",
  "trigger-hit": "typeTriggerHit",
  "follow-settled": "typeFollowSettled",
  "worker-health": "typeWorkerHealth",
  "token-event": "typeTokenEvent",
  "spike-alert": "typeSpikeAlert",
};

function toneFor(type: string): "bullish" | "info" | "warning" | "neutral" {
  if (type === "setup-found") return "bullish";
  if (type === "trigger-hit" || type === "follow-settled" || type === "spike-alert") return "info";
  if (type === "worker-health" || type === "token-event") return "warning";
  return "neutral";
}

function AlertsPage() {
  const { t } = useTranslation();
  const items = useNotificationsStore((s) => s.items);
  const permission = useNotificationsStore((s) => s.permission);
  const requestPermission = useNotificationsStore((s) => s.requestPermission);
  const [filter, setFilter] = useState<string>("all");

  const types = useMemo(() => [...new Set(items.map((i) => i.type))], [items]);
  const shown = items.filter((i) => filter === "all" || i.type === filter);
  const typeLabel = (type: string) =>
    TYPE_LABEL_KEY[type] ? t(`routes.alerts.${TYPE_LABEL_KEY[type]}`) : type;

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <PageHeader
        eyebrow={t("nav.groups.trading")}
        title={t("routes.alerts.title")}
        subtitle={t("routes.alerts.subtitle")}
        action={
          permission !== "granted" && permission !== "unsupported" ? (
            <button
              type="button"
              onClick={() => void requestPermission()}
              className="flex items-center gap-1.5 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-xs font-semibold text-info transition-colors hover:bg-info/20"
            >
              <Bell className="h-3.5 w-3.5" />
              {t("routes.alerts.enableBrowserAlerts")}
            </button>
          ) : null
        }
      />

      {types.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {["all", ...types].map((ty) => (
            <button
              key={ty}
              onClick={() => setFilter(ty)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                filter === ty
                  ? "border-info bg-info-soft text-info"
                  : "border-border bg-surface text-muted-foreground hover:text-foreground",
              )}
            >
              {ty === "all" ? t("routes.alerts.all") : typeLabel(ty)}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <IqCard className="flex flex-col items-center py-12 text-center">
          <BellOff className="mb-3 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">{t("routes.alerts.emptyTitle")}</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t("routes.alerts.emptyBodyPrefix")}{" "}
            <Link to="/watchlist" className="text-info hover:underline">
              {t("routes.alerts.watchlist")}
            </Link>{" "}
            {t("routes.alerts.emptyBodySuffix")}
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
  const { t } = useTranslation();
  const inner = (
    <div className="flex flex-col gap-1 px-5 py-3 transition-colors hover:bg-surface/50">
      <div className="flex items-center gap-2">
        <StatusBadge tone={toneFor(event.type)}>
          {TYPE_LABEL_KEY[event.type] ? t(`routes.alerts.${TYPE_LABEL_KEY[event.type]}`) : event.type}
        </StatusBadge>
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
