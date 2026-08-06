import { createFileRoute, Link } from "@tanstack/react-router";
import { Landmark, Lock, Coins } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { PageHeader } from "@/components/features/page-header";
import { SkeletonCard } from "@/components/features/skeletons";
import { StatusBadge } from "@/components/features/status-badge";
import { useEconomicEvents } from "@/hooks/queries";
import { useNow } from "@/hooks/useNow";
import { useTokenEventsForSymbols } from "@/hooks/useTokenEvents";
import { useWatchlistStore } from "@/stores/watchlist";
import { humanRelative, localTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * The forward calendar: macro prints from the econ ingest plus dated token
 * events for watched tokens, grouped by day. Scheduling facts only — the size
 * of an unlock is reported when the provider gives one, never estimated.
 */
export const Route = createFileRoute("/events")({
  head: () => ({
    meta: [
      { title: "Events — Market Pulse" },
      {
        name: "description",
        content: "Macro calendar and token events ahead: what is scheduled and when.",
      },
    ],
  }),
  component: EventsPage,
});

type Filter = "all" | "macro" | "token";

interface Row {
  id: string;
  title: string;
  detail: string;
  impact: "high" | "medium" | "low" | "holiday";
  at: number;
  symbol: string | null;
  kind: "macro" | "token";
  icon: typeof Landmark;
}

const WINDOW_DAYS = 14;

function EventsPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const calendar = useEconomicEvents(WINDOW_DAYS, "low");
  const watched = useWatchlistStore((s) => s.tickers);
  const tokenEvents = useTokenEventsForSymbols(watched);
  const now = useNow();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const e of calendar.data ?? []) {
      const at = new Date(e.occursAt).getTime();
      if (at < now) continue;
      out.push({
        id: `econ:${e.id}`,
        title: e.title,
        detail: [
          e.country,
          e.forecast ? t("routes.events.forecast", { value: e.forecast }) : null,
          e.previous ? t("routes.events.previous", { value: e.previous }) : null,
        ]
          .filter(Boolean)
          .join(" · "),
        impact: e.impact,
        at,
        symbol: null,
        kind: "macro",
        icon: Landmark,
      });
    }
    for (const e of tokenEvents.data ?? []) {
      const at = new Date(e.publishedAt).getTime();
      if (at < now) continue;
      out.push({
        id: `token:${e.id}`,
        title: e.title,
        detail: [e.kind, e.source, e.body].filter(Boolean).join(" · "),
        impact: e.severity === "critical" ? "high" : e.severity === "warning" ? "medium" : "low",
        at,
        symbol: e.symbol,
        kind: "token",
        icon: e.kind === "unlock" ? Lock : Coins,
      });
    }
    return out.sort((a, b) => a.at - b.at);
  }, [calendar.data, tokenEvents.data, now, t]);

  const shown = rows.filter((r) => filter === "all" || r.kind === filter);

  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of shown) {
      const key = new Date(r.at).toDateString();
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()];
  }, [shown]);

  const loading = calendar.isLoading && tokenEvents.isLoading;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <PageHeader
        eyebrow={t("routes.events.eyebrow")}
        title={t("routes.events.title")}
        subtitle={t("routes.events.subtitle", { days: WINDOW_DAYS })}
      />

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { labelKey: "filterAll", value: "all" },
            { labelKey: "filterMacro", value: "macro" },
            { labelKey: "filterToken", value: "token" },
          ] as const
        ).map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              filter === f.value
                ? "border-info bg-info-soft text-info"
                : "border-border bg-surface text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`routes.events.${f.labelKey}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          <SkeletonCard height={120} />
          <SkeletonCard height={120} />
        </div>
      ) : byDay.length === 0 ? (
        <IqCard>
          <p className="text-sm font-medium">{t("routes.events.emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("routes.events.emptyBody")}</p>
        </IqCard>
      ) : (
        byDay.map(([day, items]) => (
          <div key={day} className="flex flex-col gap-2">
            <CardEyebrow>
              {new Date(items[0].at).toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </CardEyebrow>
            <IqCard padded={false}>
              <ul className="flex flex-col divide-y divide-border">
                {items.map((r) => {
                  const Icon = r.icon;
                  const row = (
                    <div className="flex items-center gap-3 px-5 py-3">
                      <span
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                          r.impact === "high"
                            ? "bg-bearish-soft text-bearish"
                            : r.impact === "medium"
                              ? "bg-warning-soft text-warning"
                              : "bg-muted/50 text-muted-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">
                            {r.symbol ? `${r.symbol} · ` : ""}
                            {r.title}
                          </p>
                          {r.impact === "high" && (
                            <StatusBadge tone="bearish">{t("routes.events.highImpact")}</StatusBadge>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[11px] capitalize text-muted-foreground">
                          {r.detail}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="num text-xs text-foreground">{localTime(r.at)}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {humanRelative(r.at, now)}
                        </div>
                      </div>
                    </div>
                  );
                  return (
                    <li key={r.id}>
                      {r.symbol ? (
                        <Link
                          to="/token/$symbol"
                          params={{ symbol: r.symbol }}
                          className="block transition-colors hover:bg-surface/50"
                        >
                          {row}
                        </Link>
                      ) : (
                        row
                      )}
                    </li>
                  );
                })}
              </ul>
            </IqCard>
          </div>
        ))
      )}
    </div>
  );
}
