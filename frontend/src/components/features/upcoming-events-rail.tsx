import { Link } from "@tanstack/react-router";
import { CalendarClock, Coins, Landmark, Lock } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CardEyebrow, IqCard } from "./iq-card";
import { StatusBadge } from "./status-badge";
import { SkeletonCard } from "./skeletons";
import { useEconomicEvents } from "@/hooks/queries";
import { useNow } from "@/hooks/useNow";
import { useTokenEventsForSymbols } from "@/hooks/useTokenEvents";
import { useWatchlistStore } from "@/stores/watchlist";
import { humanRelative, localDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * Forward calendar rail: macro prints from the econ ingest plus dated token
 * events (unlocks, listings…) for whatever the user watches. Purely
 * scheduling facts — nothing here implies a direction.
 */

interface RailEvent {
  id: string;
  title: string;
  category: string;
  impact: "high" | "medium" | "low" | "holiday";
  at: number;
  symbol: string | null;
  icon: "macro" | "unlock" | "token";
}

const ICONS = {
  macro: Landmark,
  unlock: Lock,
  token: Coins,
} as const;

export function UpcomingEventsRail({ days = 7 }: { days?: number }) {
  const { t } = useTranslation();
  const calendar = useEconomicEvents(days, "medium");
  const watched = useWatchlistStore((s) => s.tickers);
  const tokenEvents = useTokenEventsForSymbols(watched);
  // Ticks every minute so the countdowns below stay honest.
  const now = useNow();

  const events = useMemo<RailEvent[]>(() => {
    const horizon = now + days * 24 * 60 * 60 * 1000;
    const out: RailEvent[] = [];

    for (const e of calendar.data ?? []) {
      const at = new Date(e.occursAt).getTime();
      if (at < now || at > horizon) continue;
      out.push({
        id: `econ:${e.id}`,
        title: e.title,
        category: t("components.batchD.upcomingEvents.macroCategory", { country: e.country }),
        impact: e.impact,
        at,
        symbol: null,
        icon: "macro",
      });
    }

    for (const e of tokenEvents.data ?? []) {
      const at = new Date(e.publishedAt).getTime();
      if (at < now || at > horizon) continue;
      out.push({
        id: `token:${e.id}`,
        title: e.title,
        category:
          e.kind === "unlock"
            ? t("components.batchD.upcomingEvents.tokenUnlockCategory")
            : t("components.batchD.upcomingEvents.tokenEventCategory", { kind: e.kind }),
        impact: e.severity === "critical" ? "high" : e.severity === "warning" ? "medium" : "low",
        at,
        symbol: e.symbol,
        icon: e.kind === "unlock" ? "unlock" : "token",
      });
    }

    return out.sort((a, b) => a.at - b.at).slice(0, 6);
  }, [calendar.data, tokenEvents.data, days, now, t]);

  const loading = calendar.isLoading && tokenEvents.isLoading;

  return (
    <IqCard padded={false} className="flex flex-col p-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>{t("components.batchD.upcomingEvents.title")}</CardEyebrow>
        <Link to="/events" className="text-xs font-medium text-info hover:underline">
          {t("components.batchD.upcomingEvents.viewAll")}
        </Link>
      </div>

      {loading ? (
        <div className="mt-4 flex flex-col gap-2">
          <SkeletonCard height={60} />
          <SkeletonCard height={60} />
        </div>
      ) : events.length === 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {t("components.batchD.upcomingEvents.empty", { days })}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border">
          {events.map((e) => {
            const Icon = ICONS[e.icon];
            const row = (
              <div className="flex gap-3 py-3">
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                    e.impact === "high"
                      ? "bg-bearish-soft text-bearish"
                      : e.impact === "medium"
                        ? "bg-warning-soft text-warning"
                        : "bg-muted/50 text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <p className="line-clamp-2 flex-1 text-sm font-medium leading-snug">
                      {e.symbol ? `${e.symbol} · ` : ""}
                      {e.title}
                    </p>
                    {e.impact === "high" && (
                      <StatusBadge tone="bearish">
                        {t("components.batchD.upcomingEvents.highImpact")}
                      </StatusBadge>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] capitalize text-muted-foreground">
                    {e.category}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "text-[11px] font-semibold",
                      e.at - now < 60 * 60 * 1000 ? "text-warning" : "text-foreground",
                    )}
                  >
                    {humanRelative(e.at, now)}
                  </div>
                  <div className="num text-[10px] text-muted-foreground">
                    {localDateTime(e.at, now)}
                  </div>
                </div>
              </div>
            );
            return (
              <li key={e.id}>
                {e.symbol ? (
                  <Link
                    to="/token/$symbol"
                    params={{ symbol: e.symbol }}
                    className="block transition-colors hover:bg-surface/50"
                  >
                    {row}
                  </Link>
                ) : (
                  <Link to="/events" className="block transition-colors hover:bg-surface/50">
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!loading && events.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 border-t border-border pt-2 text-[10px] text-muted-foreground">
          <CalendarClock className="h-3 w-3" />
          {t("components.batchD.upcomingEvents.footer")}
        </p>
      )}
    </IqCard>
  );
}
