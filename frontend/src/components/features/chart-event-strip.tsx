import { ExternalLink } from "lucide-react";

import { TONE_HEX, kindLabel, whenLabel, type ChartEvent } from "@/lib/engine/event-markers";
import { cn } from "@/lib/utils";

/**
 * The quick-action event strip below the price chart — a scannable, scrollable
 * row of the same news + calendar events the chart plots as markers. Each chip
 * is a per-kind traffic light (red / grey / green); upcoming calendar items get
 * a ⧗ prefix and a dashed border to read as "ahead", not "happened". Clicking a
 * chip opens its source (new tab) when one exists and highlights it on the
 * chart via `onFocus`. Presentational only — the parent owns the event list.
 */
export function ChartEventStrip({
  events,
  activeId,
  onFocus,
  nowMs = Date.now(),
}: {
  events: ChartEvent[];
  /** Id of the event currently selected on the chart, ringed here to match. */
  activeId?: string | null;
  onFocus?: (event: ChartEvent) => void;
  nowMs?: number;
}) {
  if (events.length === 0) return null;
  // Upcoming first (what to prepare for), then most-recent past.
  const ordered = [...events].sort((a, b) => {
    if (a.when !== b.when) return a.when === "upcoming" ? -1 : 1;
    return a.when === "upcoming" ? a.timeSec - b.timeSec : b.timeSec - a.timeSec;
  });

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="shrink-0 whitespace-nowrap pr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Events
      </span>
      {ordered.map((event) => {
        const hex = TONE_HEX[event.tone];
        const active = event.id === activeId;
        return (
          <button
            key={event.id}
            type="button"
            title={`${event.title} — ${event.source}`}
            onClick={() => {
              onFocus?.(event);
              if (event.url) window.open(event.url, "_blank", "noopener,noreferrer");
            }}
            className={cn(
              "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors hover:bg-surface",
              event.when === "upcoming" ? "border-dashed" : "border-solid",
              active ? "ring-1 ring-info" : "",
            )}
            style={{ borderColor: `${hex}66` }}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: hex }} />
            {event.when === "upcoming" && <span className="text-muted-foreground">⧗</span>}
            <span className="text-foreground">{kindLabel(event.kind)}</span>
            <span className="text-muted-foreground">{whenLabel(event.timeSec, nowMs)}</span>
            {event.url && <ExternalLink className="h-2.5 w-2.5 text-muted-foreground" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The floating detail card shown when a chart marker is clicked — lists every
 * event that shares that bar. Positioned by the parent inside the chart's
 * relatively-positioned container.
 */
export function ChartEventPopup({
  events,
  x,
  y,
  onClose,
  nowMs = Date.now(),
}: {
  events: ChartEvent[];
  x: number;
  y: number;
  onClose: () => void;
  nowMs?: number;
}) {
  // Clamp horizontally so a right-edge click doesn't push the card off-screen.
  const left = Math.min(Math.max(8, x - 120), Math.max(8, x));
  return (
    <div
      className="absolute z-20 w-60 max-w-[80%] rounded-md border border-border bg-popover p-2 text-xs shadow-lg"
      style={{ left, top: Math.max(8, y + 12) }}
      role="dialog"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {events.length > 1 ? `${events.length} events` : "Event"}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {events.map((event) => {
          const hex = TONE_HEX[event.tone];
          const inner = (
            <div className="flex items-start gap-1.5">
              <span
                className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: hex }}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span>{kindLabel(event.kind)}</span>
                  <span>·</span>
                  <span>{whenLabel(event.timeSec, nowMs)}</span>
                  {event.url && <ExternalLink className="h-2.5 w-2.5" />}
                </div>
                <p className="line-clamp-2 leading-snug text-popover-foreground">{event.title}</p>
                <span className="text-[10px] text-muted-foreground">{event.source}</span>
              </div>
            </div>
          );
          return (
            <li key={event.id}>
              {event.url ? (
                <a href={event.url} target="_blank" rel="noopener noreferrer" className="block">
                  {inner}
                </a>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
