import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/features/page-header";
import {
  useForwardTest,
  type ForwardTestSetup,
  type ForwardTestStatus,
} from "@/hooks/useForwardTest";
import { cn } from "@/lib/utils";

/**
 * The forward-test research view.
 *
 * Every confirmed setup the Discover scanner produced, the plan it was
 * recorded with, and what price actually did afterwards. Read-only and
 * complete: there is no control here that hides, edits or deletes a row,
 * because a dataset you can curate is not evidence.
 *
 * The purpose is observation, not optimization. Nothing on this page is a
 * position, and nothing was ever sent to an exchange.
 */
export const Route = createFileRoute("/forward-test")({
  head: () => ({
    meta: [
      { title: "Forward test — Market Pulse" },
      {
        name: "description",
        content:
          "Forward-test results for the Discover scanner: every confirmed setup, the plan frozen at detection, and what happened next.",
      },
    ],
  }),
  component: ForwardTestPage,
});

const STATUS_FILTERS: (ForwardTestStatus | null)[] = [
  null,
  "PENDING_ENTRY",
  "ACTIVE",
  "TARGET_HIT",
  "INVALIDATED",
  "NO_FILL",
  "EXPIRED",
];

const STATUS_CLASS: Record<string, string> = {
  PENDING_ENTRY: "text-muted-foreground",
  ACTIVE: "text-info",
  TARGET_HIT: "text-bullish",
  INVALIDATED: "text-bearish",
  EXPIRED: "text-warning",
  NO_FILL: "text-muted-foreground",
};

const MODES: (string | null)[] = [null, "SCALP", "INTRADAY"];

function price(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return value.toFixed(1);
  if (value >= 1) return value.toFixed(3);
  return value.toPrecision(4);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function clock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** One headline number. Deliberately flat — no sparklines, no deltas: there is
 * not enough data yet for a trend to mean anything. */
function Card({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("num mt-1 text-xl font-bold tabular-nums", tone)}>{value}</div>
      {hint !== undefined && (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function rTone(value: number): string {
  if (value > 0) return "text-bullish";
  if (value < 0) return "text-bearish";
  return "text-muted-foreground";
}

function Row({ setup }: { setup: ForwardTestSetup }) {
  const { t } = useTranslation();
  const n = "routes.forwardTest.";
  const settled = setup.settledAt !== null;
  return (
    <tr className="border-t border-border/60 hover:bg-surface/60">
      <td className="whitespace-nowrap px-2 py-1.5">
        <span className="font-semibold">{setup.symbol}</span>
        <span className="ml-1 text-[10px] uppercase text-muted-foreground">{setup.mode}</span>
      </td>
      <td
        className={cn(
          "px-2 py-1.5 text-[11px] font-medium",
          setup.direction === "bullish" ? "text-bullish" : "text-bearish",
        )}
      >
        {t(`${n}direction.${setup.direction}`)}
      </td>
      <td className="num whitespace-nowrap px-2 py-1.5 text-[11px] text-muted-foreground">
        {clock(setup.detectedAt)}
      </td>
      <td className="num px-2 py-1.5 text-[11px]">
        {price(setup.referenceEntry)}
        {setup.entryPrice !== null && (
          <span className="ml-1 text-muted-foreground">→ {price(setup.entryPrice)}</span>
        )}
      </td>
      <td className="num px-2 py-1.5 text-[11px]">
        {price(setup.initialInvalidation)}
        {/* The stop in force, when trailing has moved it off the structural one. */}
        {setup.activeStop !== setup.initialInvalidation && (
          <span className="ml-1 text-info">→ {price(setup.activeStop)}</span>
        )}
      </td>
      <td className="num px-2 py-1.5 text-[11px]">{price(setup.target)}</td>
      <td className="num px-2 py-1.5 text-[11px] text-muted-foreground">
        {setup.potentialRr.toFixed(1)}R
      </td>
      <td className={cn("px-2 py-1.5 text-[11px] font-medium", STATUS_CLASS[setup.status])}>
        {t(`${n}status.${setup.status}`)}
      </td>
      <td className={cn("num px-2 py-1.5 text-[11px] font-semibold", rTone(setup.realizedR))}>
        {settled ? `${setup.realizedR.toFixed(2)}R` : "—"}
      </td>
      <td className="num px-2 py-1.5 text-[11px] text-bullish">{setup.mfeR.toFixed(2)}R</td>
      <td className="num px-2 py-1.5 text-[11px] text-bearish">{setup.maeR.toFixed(2)}R</td>
      <td className="num px-2 py-1.5 text-[11px] text-muted-foreground">
        {duration(setup.timeInTrade ?? setup.timeToEntry)}
      </td>
    </tr>
  );
}

function ForwardTestPage() {
  const { t } = useTranslation();
  const n = "routes.forwardTest.";
  const [mode, setMode] = useState<string | null>(null);
  const [status, setStatus] = useState<ForwardTestStatus | null>(null);
  const { data, loading } = useForwardTest(mode, status);

  const stats = data?.stats;
  const summary = data?.summary;
  const best = summary?.bestSetup ?? null;

  const cards = useMemo(() => {
    if (stats === undefined || summary === undefined) return [];
    return [
      {
        label: t(`${n}cards.daysRunning`),
        value: summary.daysRunning.toFixed(1),
        hint: summary.firstDetectedAt !== null ? clock(summary.firstDetectedAt) : undefined,
      },
      {
        label: t(`${n}cards.recorded`),
        value: String(summary.setupsRecorded),
        hint: t(`${n}cards.recordedHint`, { universe: summary.scannedUniverse }),
      },
      {
        label: t(`${n}cards.open`),
        value: String(stats.open),
        hint: t(`${n}cards.openHint`),
      },
      {
        label: t(`${n}cards.fillRate`),
        value: pct(stats.fillRate),
        hint: t(`${n}cards.fillRateHint`, { count: stats.noFill }),
      },
      {
        label: t(`${n}cards.winRate`),
        value: pct(stats.winRate),
        hint: t(`${n}cards.winRateHint`, { filled: stats.filled }),
      },
      {
        label: t(`${n}cards.totalR`),
        value: `${stats.totalR.toFixed(2)}R`,
        tone: rTone(stats.totalR),
        hint: t(`${n}cards.totalRHint`, { avg: stats.averageR.toFixed(2) }),
      },
      {
        label: t(`${n}cards.expectancy`),
        value: `${stats.expectancy.toFixed(2)}R`,
        tone: rTone(stats.expectancy),
        hint: t(`${n}cards.expectancyHint`),
      },
      {
        label: t(`${n}cards.profitFactor`),
        value: stats.profitFactor > 0 ? stats.profitFactor.toFixed(2) : "—",
        hint: t(`${n}cards.drawdown`, { value: stats.maxDrawdownR.toFixed(2) }),
      },
      {
        label: t(`${n}cards.best`),
        value: best !== null ? `${best.realizedR.toFixed(2)}R` : "—",
        tone: best !== null ? rTone(best.realizedR) : undefined,
        hint: best !== null ? `${best.symbol} · ${best.mode}` : undefined,
      },
    ];
  }, [stats, summary, best, t]);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      <PageHeader eyebrow={t(`${n}eyebrow`)} title={t(`${n}title`)} subtitle={t(`${n}subtitle`)} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full border border-border p-0.5">
          {MODES.map((option) => (
            <button
              key={option ?? "ALL"}
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
              {option === null ? t(`${n}allModes`) : t(`components.momentum.mode.${option}`)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option ?? "ALL"}
              type="button"
              onClick={() => setStatus(option)}
              aria-pressed={status === option}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
                status === option
                  ? "border-foreground/40 bg-surface text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {option === null ? t(`${n}allStatuses`) : t(`${n}status.${option}`)}
            </button>
          ))}
        </div>

        {summary !== undefined && (
          <span className="num ml-auto truncate text-[10px] text-muted-foreground">
            {summary.strategyVersion}
            {summary.configHash !== "" && ` · cfg ${summary.configHash}`}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((card) => (
          <Card
            key={card.label}
            label={card.label}
            value={card.value}
            hint={card.hint}
            tone={card.tone}
          />
        ))}
      </div>

      {loading && data === null && (
        <p className="text-xs text-muted-foreground">{t(`${n}loading`)}</p>
      )}

      {data !== null && data.setups.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          {t(`${n}empty`)}
        </p>
      )}

      {data !== null && data.setups.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="bg-surface text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-2">{t(`${n}columns.symbol`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.direction`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.detected`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.entry`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.stop`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.target`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.rr`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.status`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.realized`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.mfe`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.mae`)}</th>
                <th className="px-2 py-2">{t(`${n}columns.duration`)}</th>
              </tr>
            </thead>
            <tbody>
              {data.setups.map((setup) => (
                <Row key={setup.id} setup={setup} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">{t(`${n}disclaimer`)}</p>
    </div>
  );
}
