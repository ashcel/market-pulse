import { AlertTriangle, ExternalLink, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { CardEyebrow } from "@/components/features/iq-card";
import { useTokenEvents, type TokenEvent } from "@/hooks/useTokenEvents";
import { cn } from "@/lib/utils";
import type { TokenEventKind, TokenEventSeverity } from "@/lib/engine/token-events";
import { humanRelative } from "@/lib/time";

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

function EventRow({ event }: { event: TokenEvent }) {
  const { t } = useTranslation();
  const kindLabel = t(`components.batchB.tokenEvents.kind.${event.kind}`, {
    defaultValue: KIND_LABEL[event.kind] ?? event.kind,
  });
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
            {kindLabel}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {humanRelative(event.publishedAt)} · {event.source}
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
  const { t } = useTranslation();
  const { data: events } = useTokenEvents(symbol);
  if (!events || events.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center gap-1.5">
        <CardEyebrow>{t("components.batchB.tokenEvents.title")}</CardEyebrow>
        <span className="text-[10px] text-muted-foreground">
          {t("components.batchB.tokenEvents.description")}
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
