import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Trash2, TrendingDown, TrendingUp } from "lucide-react";

import { AssetIcon } from "@/components/iq/asset-icon";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { PageHeader } from "@/components/iq/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLivePrice } from "@/hooks/useLivePrice";
import { INTENTS } from "@/lib/engine/intent";
import {
  isTerminalStatus,
  summarizeTrackedSignals,
  type TrackedSignal,
  type TrackedSignalStatus,
} from "@/lib/engine/tracker";
import {
  MIN_SHADOW_RECORD_TRADES,
  shadowComboStats,
  summarizeShadowRecord,
} from "@/lib/engine/shadow";
import { formatEntryRange, formatMoney } from "@/lib/format";
import { useShadowSignalsStore } from "@/stores/shadow-signals";
import { useTrackedSignalsStore } from "@/stores/tracked-signals";
import { cn } from "@/lib/utils";

function humanize(value: string): string {
  return value
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export const Route = createFileRoute("/tracker")({
  head: () => ({
    meta: [
      { title: "Signal Tracker — IQ" },
      {
        name: "description",
        content: "Forward-test the signals you've followed against live price.",
      },
      { property: "og:title", content: "Signal Tracker — IQ" },
      {
        property: "og:description",
        content: "No backtest hindsight — just what actually happened after you followed a call.",
      },
    ],
  }),
  component: TrackerPage,
});

const STATUS_LABEL: Record<TrackedSignalStatus, string> = {
  active: "Active",
  "target1-hit": "Target 1 hit",
  "target2-hit": "Target 2 hit",
  "stopped-out": "Stopped out",
};

const STATUS_TONE: Record<TrackedSignalStatus, string> = {
  active: "border-info/30 bg-info-soft text-info",
  "target1-hit": "border-bullish/30 bg-bullish-soft text-bullish",
  "target2-hit": "border-bullish/30 bg-bullish-soft text-bullish",
  "stopped-out": "border-bearish/30 bg-bearish-soft text-bearish",
};

type Filter = "all" | "open" | "closed";

const FILTERS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
];

const INTENT_LABEL = new Map(INTENTS.map((def) => [def.intent, def.label]));

function TrackerPage() {
  const signals = useTrackedSignalsStore((s) => s.signals);
  const [filter, setFilter] = useState<Filter>("all");
  const summary = summarizeTrackedSignals(signals);

  const filtered = signals.filter((s) => {
    if (filter === "open") return !isTerminalStatus(s.status);
    if (filter === "closed") return isTerminalStatus(s.status);
    return true;
  });

  return (
    <div className="space-y-5 pb-20 lg:pb-6">
      <PageHeader
        eyebrow="Forward Test"
        title="Signal Tracker"
        subtitle="Follow a signal from any token's Execution Plan, then watch what actually happens — no backtest hindsight."
      />

      <EngineRecord />

      <div className="flex items-center gap-1.5 pt-1">
        <CardEyebrow>Signals You Followed</CardEyebrow>
      </div>

      <IqCard className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Followed" value={String(summary.total)} />
        <StatTile label="Open" value={String(summary.open)} />
        <StatTile
          label="Win rate"
          value={summary.closed ? `${summary.winRate}%` : "—"}
          tone={summary.closed ? (summary.winRate >= 50 ? "bullish" : "bearish") : undefined}
        />
        <StatTile
          label="Avg R (closed)"
          value={summary.closed ? `${summary.averageR >= 0 ? "+" : ""}${summary.averageR}R` : "—"}
          tone={summary.closed ? (summary.averageR >= 0 ? "bullish" : "bearish") : undefined}
        />
      </IqCard>
      {summary.lowSample && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Only {summary.closed} closed trade{summary.closed === 1 ? "" : "s"} so far — too few to
          trust win rate or average R as a real statistic yet.
        </p>
      )}

      <div className="flex items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              filter === f.value
                ? "border-info/30 bg-info-soft text-info"
                : "border-border bg-surface text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <IqCard className="text-center text-sm text-muted-foreground">
          {signals.length === 0
            ? "Nothing tracked yet — follow a signal from a token's Execution Plan to start forward-testing it here."
            : "No signals match this filter."}
        </IqCard>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((signal) => (
            <TrackedSignalRow key={signal.id} signal={signal} />
          ))}
        </div>
      )}
    </div>
  );
}

function EngineRecord() {
  const signals = useShadowSignalsStore((s) => s.signals);
  const summary = summarizeShadowRecord(signals);
  const combos = shadowComboStats(signals);

  return (
    <IqCard className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardEyebrow>Engine's Live Record</CardEyebrow>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Every time the assistant issues a <span className="font-semibold">favored</span> verdict
            it's auto-recorded here and settled against real candle highs and lows — nothing
            cherry-picked, no follow required. Combos with a proven losing record get demoted to
            half-size on the token page.
          </p>
        </div>
      </div>

      {summary.total === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-3 text-xs text-muted-foreground">
          No favored verdicts recorded yet. Open a few tokens and the engine starts building its own
          track record automatically as verdicts fire.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="Calls made" value={String(summary.total)} />
            <StatTile label="Still open" value={String(summary.open)} />
            <StatTile
              label="Win rate"
              value={summary.closed ? `${summary.winRate}%` : "—"}
              tone={summary.closed ? (summary.winRate >= 50 ? "bullish" : "bearish") : undefined}
            />
            <StatTile
              label="Avg R (settled)"
              value={
                summary.closed ? `${summary.averageR >= 0 ? "+" : ""}${summary.averageR}R` : "—"
              }
              tone={summary.closed ? (summary.averageR >= 0 ? "bullish" : "bearish") : undefined}
            />
          </div>

          {summary.lowSample && (
            <p className="text-[11px] text-muted-foreground">
              Only {summary.closed} settled call{summary.closed === 1 ? "" : "s"} so far — the
              engine needs {MIN_SHADOW_RECORD_TRADES} per setup/regime combo before it trusts a
              record enough to demote a verdict.
            </p>
          )}

          {combos.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                By setup × regime
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="pb-1.5 pr-2 font-semibold">Setup</th>
                      <th className="pb-1.5 pr-2 font-semibold">Regime</th>
                      <th className="pb-1.5 pr-2 text-right font-semibold">Settled</th>
                      <th className="pb-1.5 pr-2 text-right font-semibold">Win</th>
                      <th className="pb-1.5 text-right font-semibold">Avg R</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combos.map((combo) => (
                      <tr
                        key={`${combo.setupType}|${combo.regime}`}
                        className="border-t border-border/60"
                      >
                        <td className="py-1.5 pr-2 font-medium">
                          <span className="flex items-center gap-1.5">
                            {humanize(combo.setupType)}
                            {combo.demoted && (
                              <Badge
                                variant="outline"
                                className="border-warning/30 bg-warning-soft px-1 py-0 text-[9px] text-warning"
                              >
                                demoted
                              </Badge>
                            )}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-muted-foreground">
                          {humanize(combo.regime)}
                        </td>
                        <td className="num py-1.5 pr-2 text-right text-muted-foreground">
                          {combo.closed}
                        </td>
                        <td className="num py-1.5 pr-2 text-right">{combo.winRate}%</td>
                        <td
                          className={cn(
                            "num py-1.5 text-right font-semibold",
                            combo.averageR >= 0 ? "text-bullish" : "text-bearish",
                          )}
                        >
                          {combo.averageR >= 0 ? "+" : ""}
                          {combo.averageR}R
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </IqCard>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 text-sm font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function TrackedSignalRow({ signal }: { signal: TrackedSignal }) {
  const applyPriceUpdate = useTrackedSignalsStore((s) => s.applyPriceUpdate);
  const remove = useTrackedSignalsStore((s) => s.remove);
  const terminal = isTerminalStatus(signal.status);
  const live = useLivePrice(signal.symbol, !terminal, signal.market ?? "spot");

  useEffect(() => {
    if (live?.price) applyPriceUpdate(signal.id, live.price);
  }, [live?.price, signal.id, applyPriceUpdate]);

  const long = signal.direction === "long";
  const currentPrice = live?.price ?? signal.closePrice ?? signal.entryPrice;

  let liveR: number | null = null;
  if (signal.status === "active") {
    const riskPerUnit = Math.abs(signal.entryPrice - signal.stop);
    if (riskPerUnit > 0) {
      const raw = long
        ? (currentPrice - signal.entryPrice) / riskPerUnit
        : (signal.entryPrice - currentPrice) / riskPerUnit;
      liveR = Math.round(raw * 100) / 100;
    }
  }

  return (
    <IqCard className="flex flex-wrap items-center gap-3 p-3">
      <AssetIcon ticker={signal.symbol} className="h-8 w-8 text-sm" />
      <div className="min-w-[110px] flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">{signal.symbol}</span>
          {long ? (
            <TrendingUp className="h-3.5 w-3.5 text-bullish" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5 text-bearish" />
          )}
          <span className="text-xs text-muted-foreground">
            {INTENT_LABEL.get(signal.intent) ?? signal.intent} · {signal.timeframe}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Followed {new Date(signal.followedAt).toLocaleString()}
        </div>
      </div>

      <Badge variant="outline" className={cn("shrink-0", STATUS_TONE[signal.status])}>
        {STATUS_LABEL[signal.status]}
      </Badge>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Metric label="Entry" value={formatMoney(signal.entryPrice)} />
        <Metric
          label="Ideal zone was"
          value={formatEntryRange(signal.entryLow, signal.entryHigh)}
        />
        <Metric label="Stop" value={formatMoney(signal.stop)} />
        <Metric label="Target 1" value={formatMoney(signal.target1)} />
        <Metric label="Target 2" value={formatMoney(signal.target2)} />
        <Metric
          label={terminal ? "Closed at" : "Current"}
          value={formatMoney(terminal ? (signal.closePrice ?? currentPrice) : currentPrice)}
        />
        <Metric
          label={terminal ? "Result" : "Unrealized"}
          value={
            terminal
              ? signal.resultR !== undefined
                ? `${signal.resultR >= 0 ? "+" : ""}${signal.resultR}R`
                : "—"
              : liveR !== null
                ? `${liveR >= 0 ? "+" : ""}${liveR}R`
                : "—"
          }
        />
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="ml-auto shrink-0 text-muted-foreground hover:text-bearish"
        onClick={() => remove(signal.id)}
        aria-label={`Remove ${signal.symbol} from tracker`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </IqCard>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="num font-semibold">{value}</div>
    </div>
  );
}
