import { Link } from "@tanstack/react-router";
import { CalendarClock, Coins, Landmark, Lock } from "lucide-react";
import { useMemo } from "react";

import { CardEyebrow, IqCard } from "./iq-card";
import { StatusBadge } from "./status-badge";
import { SkeletonCard } from "./skeletons";
import { useEconomicEvents } from "@/hooks/queries";
import { useTokenEventsForSymbols } from "@/hooks/useTokenEvents";
import { useWatchlistStore } from "@/stores/watchlist";
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
  allDay: boolean;
  symbol: string | null;
  icon: "macro" | "unlock" | "token";
}

const ICONS = {
  macro: Landmark,
  unlock: Lock,
  token: Coins,
} as const;

function dayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

function timeLabel(at: number, allDay: boolean): string {
  if (allDay) return "All day";
  return (
    new Date(at).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      hour12: false,
    }) + " UTC"
  );
}

export function UpcomingEventsRail({ days = 7 }: { days?: number }) {
  const calendar = useEconomicEvents(days, "medium");
  const watched = useWatchlistStore((s) => s.tickers);
  const tokenEvents = useTokenEventsForSymbols(watched);

  const events = useMemo<RailEvent[]>(() => {
    const now = Date.now();
    const horizon = now + days * 24 * 60 * 60 * 1000;
    const out: RailEvent[] = [];

    for (const e of calendar.data ?? []) {
      const at = new Date(e.occursAt).getTime();
      if (at < now || at > horizon) continue;
      out.push({
        id: `econ:${e.id}`,
        title: e.title,
        category: `${e.country} · Macro event`,
        impact: e.impact,
        at,
        allDay: false,
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
        category: e.kind === "unlock" ? "Token unlock" : `${e.kind} event`,
        impact: e.severity === "critical" ? "high" : e.severity === "warning" ? "medium" : "low",
        at,
        allDay: false,
        symbol: e.symbol,
        icon: e.kind === "unlock" ? "unlock" : "token",
      });
    }

    return out.sort((a, b) => a.at - b.at).slice(0, 6);
  }, [calendar.data, tokenEvents.data, days]);

  const loading = calendar.isLoading && tokenEvents.isLoading;

  return (
    <IqCard padded={false} className="flex flex-col p-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>Upcoming Events</CardEyebrow>
        <Link to="/events" className="text-xs font-medium text-info hover:underline">
          View all
        </Link>
      </div>

      {loading ? (
        <div className="mt-4 flex flex-col gap-2">
          <SkeletonCard height={60} />
          <SkeletonCard height={60} />
        </div>
      ) : events.length === 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Nothing scheduled in the next {days} days for your watchlist or the macro calendar.
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
                    {e.impact === "high" && <StatusBadge tone="bearish">High impact</StatusBadge>}
                  </div>
                  <p className="mt-0.5 text-[11px] capitalize text-muted-foreground">
                    {e.category}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {dayLabel(e.at)}
                  </div>
                  <div className="num text-[11px] text-muted-foreground">
                    {timeLabel(e.at, e.allDay)}
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
          Macro calendar + dated events for watched tokens
        </p>
      )}
    </IqCard>
  );
}
