import { useTranslation } from "react-i18next";

import { ago, eventMagnitude } from "@/components/features/momentum-format";
import { useMomentumTimeline, type RadarEvent, type ScanMode } from "@/hooks/useMomentumRadar";
import { cn } from "@/lib/utils";

/**
 * One symbol's event sequence, under its higher-timeframe context.
 *
 * The instantaneous state answers "what is happening"; only the sequence
 * answers "what happened". A volume anomaly that was followed by a bearish
 * displacement, a 1m CHoCH and then a continuation is a different situation
 * from the same anomaly followed by volume cooling — and the card's single
 * headline cannot express that difference.
 *
 * The context header sits above the sequence deliberately: where we are, then
 * what happened. Neither is a recommendation.
 */

const BIAS_CLASS: Record<string, string> = {
  bullish: "text-bullish",
  bearish: "text-bearish",
  neutral: "text-muted-foreground",
  mixed: "text-warning",
};

function clockTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--:--";
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false });
}

function Row({ event, now }: { event: RadarEvent; now: number }) {
  const { t } = useTranslation();
  const n = "components.momentum.";
  const magnitude = eventMagnitude(event);
  return (
    <li className="flex items-baseline gap-2 py-0.5">
      <span className="num shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {clockTime(event.ts)}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11px]",
          event.direction === "bullish"
            ? "text-bullish"
            : event.direction === "bearish"
              ? "text-bearish"
              : "text-foreground",
        )}
      >
        {t(`${n}event.${event.type}`, { defaultValue: event.type })}
        {event.qualifier !== "" && (
          <span className="ml-1 text-muted-foreground">{event.qualifier}</span>
        )}
      </span>
      {magnitude !== "" && (
        <span className="num shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {magnitude}
        </span>
      )}
      <span className="num shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {ago(now - event.ts)}
      </span>
    </li>
  );
}

export function MomentumTimeline({
  symbol,
  mode,
  fallback,
  now,
}: {
  symbol: string;
  mode: ScanMode;
  /** The last few events the radar frame already carried — shown instantly
   * while the full sequence loads. */
  fallback: RadarEvent[];
  now: number;
}) {
  const { t } = useTranslation();
  const n = "components.momentum.";
  const { data, loading } = useMomentumTimeline(symbol, mode);

  const events = data?.events.length ? data.events : fallback;
  const context = data?.context ?? null;

  return (
    <div className="space-y-2">
      {context !== null && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
          {context.reads.map((read) => (
            <span key={read.timeframe} className="text-muted-foreground">
              <span className="num font-medium text-foreground">{read.timeframe}</span>{" "}
              <span className={BIAS_CLASS[read.bias] ?? "text-muted-foreground"}>
                {t(`${n}context.${read.bias}`, { defaultValue: read.bias })}
              </span>
              {read.event !== null && <span className="ml-1 uppercase">{read.event}</span>}
            </span>
          ))}
        </div>
      )}

      {events.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {loading ? t(`${n}timelineLoading`) : t(`${n}timelineEmpty`)}
        </p>
      ) : (
        <ol className="divide-y divide-border/60">
          {[...events].reverse().map((event) => (
            <Row key={`${event.type}-${event.ts}`} event={event} now={now} />
          ))}
        </ol>
      )}
    </div>
  );
}
