import { AlertTriangle, ExternalLink, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { CardEyebrow } from "@/components/features/iq-card";
import { useTokenEvents, type TokenEvent } from "@/hooks/useTokenEvents";
import { cn } from "@/lib/utils";
import type { TokenEventKind, TokenEventSeverity } from "@/lib/engine/token-events";

/**
 * Recent token events (Phase 2.5) — unlocks, security incidents, regulatory
 * actions and the like for the open token, from the worker-ingested store.
 * Renders nothing when the token has no recent events.
 */

export const KIND_LABEL: Record<TokenEventKind, string> = {
  unlock: "Unlock",
  security: "Security",
  regulatory: "Regulatory",
  delisting: "Delisting",
  listing: "Listing",
  upgrade: "Upgrade",
};

export const SEVERITY_TONE: Record<TokenEventSeverity, string> = {
  critical: "border-bearish/30 bg-bearish-soft text-bearish",
  warning: "border-warning/30 bg-warning-soft text-warning",
  info: "border-info/30 bg-info-soft text-info",
};

function relativeTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function EventRow({ event }: { event: TokenEvent }) {
  const inner = (
    <div className="flex items-start gap-2 rounded-md border border-border bg-card px-2 py-1.5">
      {event.severity === "critical" ? (
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bearish" />
      ) : (
        <AlertTriangle
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0",
            event.severity === "warning" ? "text-warning" : "text-info",
          )}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn(
              "px-1 py-0 text-[9px] font-semibold uppercase",
              SEVERITY_TONE[event.severity],
            )}
          >
            {KIND_LABEL[event.kind] ?? event.kind}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {relativeTime(event.publishedAt)} · {event.source}
          </span>
          {event.url && (
            <ExternalLink className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/70" />
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-foreground">{event.title}</p>
      </div>
    </div>
  );
  return event.url ? (
    <a href={event.url} target="_blank" rel="noreferrer" className="block hover:opacity-80">
      {inner}
    </a>
  ) : (
    inner
  );
}

export function TokenEventsCard({ symbol }: { symbol: string }) {
  const { data: events } = useTokenEvents(symbol);
  if (!events || events.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center gap-1.5">
        <CardEyebrow>Token Events</CardEyebrow>
        <span className="text-[10px] text-muted-foreground">
          unlocks · security · regulatory — auto-detected from news
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {events.slice(0, 5).map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}
