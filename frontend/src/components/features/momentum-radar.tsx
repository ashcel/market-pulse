import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MomentumCard } from "@/components/features/momentum-card";
import {
  useMomentumRadar,
  type FunnelCounts,
  type RadarEntry,
  type RadarState,
  type ScanMode,
} from "@/hooks/useMomentumRadar";
import { cn } from "@/lib/utils";

/**
 * The realtime market-event radar `/discover` is built around.
 *
 * It shows the *surfaced* situations only — the handful that survived the
 * funnel — grouped by where each one is in its lifecycle:
 *
 *   NEW                     something abnormal just happened
 *   DEVELOPING              several observations are forming a situation
 *   PULLBACK                a meaningful impulse is retracing
 *   PULLBACK_COMPLETION     evidence suggests the retracement is ending
 *   CONTINUATION_CANDIDATE  the original move appears to be resuming
 *
 * An empty page is a valid, common answer, so the funnel line is always
 * visible: "600 markets → 4 events → 0 worth watching" explains the silence
 * instead of leaving the user wondering whether the feed broke.
 *
 * Modes are horizons, not filters: scalp reads 1m/3m events under 1H/15m
 * context, intraday reads 5m/15m under 4H/1H. Switching re-subscribes.
 */

const MODES: ScanMode[] = ["SCALP", "INTRADAY"];

const SECTIONS: RadarState[] = [
  "PULLBACK_COMPLETION",
  "CONTINUATION_CANDIDATE",
  "PULLBACK",
  "DEVELOPING",
  "NEW",
];

const DOT_STYLE: Record<RadarState, string> = {
  NEW: "bg-info",
  DEVELOPING: "bg-info",
  PULLBACK: "bg-warning",
  PULLBACK_COMPLETION: "bg-bullish",
  CONTINUATION_CANDIDATE: "bg-bullish",
  INVALID: "bg-muted-foreground",
  STALE: "bg-muted-foreground",
};

/** One clock for the whole page — every card's freshness reads from it rather
 * than owning an interval. */
function useSecondsClock(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function CardGrid({
  entries,
  now,
  expanded,
  onToggle,
}: {
  entries: RadarEntry[];
  now: number;
  expanded: string | null;
  onToggle: (symbol: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {entries.map((entry) => (
        <MomentumCard
          key={entry.symbol}
          entry={entry}
          now={now}
          expanded={expanded === entry.symbol}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function Section({
  state,
  entries,
  now,
  expanded,
  onToggle,
}: {
  state: RadarState;
  entries: RadarEntry[];
  now: number;
  expanded: string | null;
  onToggle: (symbol: string) => void;
}) {
  const { t } = useTranslation();
  const n = "components.momentum.";
  if (entries.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className={cn("h-2 w-2 rounded-full", DOT_STYLE[state])} />
        <h2 className="text-sm font-semibold">{t(`${n}section.${state}.title`)}</h2>
        <span className="num text-xs text-muted-foreground">{entries.length}</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">
          {t(`${n}section.${state}.hint`)}
        </span>
      </div>
      <CardGrid entries={entries} now={now} expanded={expanded} onToggle={onToggle} />
    </section>
  );
}

/** The compression, in one line. Always shown — it is what makes an empty
 * radar informative rather than suspicious. */
function Funnel({ counts }: { counts: FunnelCounts }) {
  const { t } = useTranslation();
  const n = "components.momentum.funnel.";
  const stages: [string, number][] = [
    [t(`${n}universe`), counts.universe],
    [t(`${n}events`), counts.events],
    [t(`${n}qualified`), counts.qualified],
    [t(`${n}structural`), counts.structural],
    [t(`${n}developing`), counts.developing],
    [t(`${n}surfaced`), counts.surfaced],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
      {stages.map(([label, value], index) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          {index > 0 && <span className="opacity-50">›</span>}
          <span className="num font-medium text-foreground">{value}</span>
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}

export function MomentumRadar() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ScanMode>("SCALP");
  const { data, loading, live } = useMomentumRadar(mode);
  const now = useSecondsClock();
  const [expanded, setExpanded] = useState<string | null>(null);
  const n = "components.momentum.";

  const bySection = useMemo(() => {
    const grouped: Record<string, RadarEntry[]> = {};
    for (const entry of data?.situations ?? []) {
      (grouped[entry.state] ??= []).push(entry);
    }
    return grouped;
  }, [data]);

  const total = data?.situations.length ?? 0;
  const toggleExpanded = (symbol: string) =>
    setExpanded((current) => (current === symbol ? null : symbol));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full border border-border p-0.5">
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              aria-pressed={mode === option}
              className={cn(
                "rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors",
                mode === option
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`${n}mode.${option}`)}
            </button>
          ))}
        </div>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          {t(`${n}mode.${mode}Hint`)}
        </span>

        <span
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
          title={live ? t(`${n}streamingTooltip`) : t(`${n}pollingTooltip`)}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              data?.connected ? "bg-bullish" : "bg-warning",
            )}
          />
          {data?.feed === "ws" ? t(`${n}liveFeed`) : t(`${n}pollingFeed`)}
        </span>
      </div>

      {data !== null && <Funnel counts={data.funnel} />}

      {loading && <p className="text-xs text-muted-foreground">{t(`${n}connecting`)}</p>}

      {!loading && data?.warmingUp === true && (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          {t(`${n}warmingUp`)}
        </p>
      )}

      {!loading && data?.warmingUp === false && total === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          {t(`${n}nothingSignificant`)}
        </p>
      )}

      {SECTIONS.map((state) => (
        <Section
          key={state}
          state={state}
          entries={bySection[state] ?? []}
          now={now}
          expanded={expanded}
          onToggle={toggleExpanded}
        />
      ))}

      {(data?.closed.length ?? 0) > 0 && (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            {t(`${n}section.CLOSED.title`)} ({data?.closed.length})
          </summary>
          <div className="mt-2">
            <CardGrid
              entries={data?.closed ?? []}
              now={now}
              expanded={expanded}
              onToggle={toggleExpanded}
            />
          </div>
        </details>
      )}
    </div>
  );
}
