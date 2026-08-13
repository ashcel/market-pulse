import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/features/page-header";
import {
  useForwardTest,
  type ForwardTestSetup,
  type ForwardTestStats,
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

const MODES: (string | null)[] = [null, "SCALP", "INTRADAY", "SWING"];

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

/** The tape a setup was detected in. Semantic colour, deliberately muted for
 * the two non-directional cases — the regime is context for the result, not a
 * result of its own. */
const REGIME_CLASS: Record<string, string> = {
  bullish: "text-bullish",
  bearish: "text-bearish",
  choppy: "text-muted-foreground",
  unknown: "text-muted-foreground",
  unrecorded: "text-muted-foreground",
};

function rTone(value: number): string {
  if (value > 0) return "text-bullish";
  if (value < 0) return "text-bearish";
  return "text-muted-foreground";
}

/** A second hand for the page. One interval, not one per row — the elapsed
 * clock on an open position has to move between polls, or a live position
 * reads as a stuck one. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function Row({ setup, now }: { setup: ForwardTestSetup; now: number }) {
  const { t } = useTranslation();
  const n = "routes.forwardTest.";
  const settled = setup.settledAt !== null;
  // Settled rows are history and read from the record. An open one is measured
  // to this instant, so the number moves whether or not anything was written.
  const elapsed = settled ? setup.timeInTrade : now - (setup.enteredAt ?? setup.detectedAt);
  return (
    <tr className="border-t border-border/60 hover:bg-surface/60">
      <td className="whitespace-nowrap px-2 py-1.5">
        <span className="font-semibold">{setup.symbol}</span>
        <span className="ml-1 text-[10px] uppercase text-muted-foreground">{setup.mode}</span>
        {setup.regime !== "" && (
          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className={REGIME_CLASS[setup.regime] ?? "text-muted-foreground"}>
              {t(`${n}regime.${setup.regime}`, setup.regime)}
            </span>
            {/* Only when it changed: a trade that outlived the tape it was
                taken in is the case worth seeing, and repeating the same word
                on every settled row would bury it. */}
            {setup.exitRegime !== "" && setup.exitRegime !== setup.regime && (
              <span className={cn("ml-1", REGIME_CLASS[setup.exitRegime])}>
                → {t(`${n}regime.${setup.exitRegime}`, setup.exitRegime)}
              </span>
            )}
          </div>
        )}
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
      <td
        className={cn(
          "num px-2 py-1.5 text-[11px] font-semibold",
          rTone(settled ? setup.realizedR : setup.unrealizedR),
        )}
      >
        {settled ? `${setup.realizedR.toFixed(2)}R` : ""}
        {/* Floating, marked at the last observed price and already charged the
            round trip — the same number it will settle as, not a flattering
            one. Only a filled position has one. */}
        {!settled && setup.entryPrice !== null && (
          <span title={t(`${n}floatingHint`)}>{setup.unrealizedR.toFixed(2)}R</span>
        )}
        {!settled && setup.entryPrice === null && "—"}
        {/* Gross, so the cost of the round trip is never hidden. */}
        {settled && setup.costR > 0 && (
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
            ({setup.grossR.toFixed(2)} − {setup.costR.toFixed(2)})
          </span>
        )}
      </td>
      <td className="num px-2 py-1.5 text-[11px] text-bullish">{setup.mfeR.toFixed(2)}R</td>
      <td className="num px-2 py-1.5 text-[11px] text-bearish">{setup.maeR.toFixed(2)}R</td>
      <td className="num px-2 py-1.5 text-[11px] text-muted-foreground">{duration(elapsed)}</td>
    </tr>
  );
}

/** What the alternative exit rules would have produced on the same setups.
 * A controlled comparison — identical detections and entries, different exits
 * — rather than a story about one trade that would have done better. */
function Variants({ setups }: { setups: ForwardTestSetup[] }) {
  const { t } = useTranslation();
  const n = "routes.forwardTest.";
  const settled = setups.filter((s) => s.settledAt !== null);
  if (settled.length === 0) return null;

  const names = Array.from(new Set(settled.flatMap((s) => Object.keys(s.variants))));
  if (names.length === 0) return null;

  const rows = [
    {
      name: t(`${n}variants.primary`),
      total: settled.reduce((sum, s) => sum + s.realizedR, 0),
      wins: settled.filter((s) => s.realizedR > 0).length,
    },
    ...names.map((name) => ({
      name,
      total: settled.reduce((sum, s) => sum + (s.variants[name]?.realized_r ?? 0), 0),
      wins: settled.filter((s) => (s.variants[name]?.realized_r ?? 0) > 0).length,
    })),
  ];

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {t(`${n}variants.title`, { count: settled.length })}
      </div>
      <div className="mt-2 flex flex-wrap gap-4">
        {rows.map((row) => (
          <div key={row.name}>
            <div className="text-[11px] text-muted-foreground">{row.name}</div>
            <div className={cn("num text-sm font-bold", rTone(row.total))}>
              {row.total.toFixed(2)}R
            </div>
            <div className="num text-[10px] text-muted-foreground">
              {row.wins}/{settled.length} {t(`${n}variants.won`)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">{t(`${n}variants.note`)}</p>
    </div>
  );
}

/** The same record cut by the tape each setup was detected in.
 *
 * This exists because of a real mistake: two cohorts were compared, one looked
 * better, and the difference turned out to be that it ran through a trending
 * afternoon while the other ran through overnight chop. One aggregate number
 * could not have shown that, and no amount of extra setups would have fixed it.
 *
 * Ordered by sample size, not by result — the biggest bucket is the one with
 * something to say, and sorting by R would put the luckiest first. */
function ByRegime({ byRegime }: { byRegime: Record<string, ForwardTestStats> }) {
  const { t } = useTranslation();
  const n = "routes.forwardTest.";
  const rows = Object.entries(byRegime)
    .filter(([, stats]) => stats.filled > 0)
    .sort((a, b) => b[1].filled - a[1].filled);
  if (rows.length < 2) return null;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {t(`${n}byRegime.title`)}
      </div>
      <div className="mt-2 flex flex-wrap gap-5">
        {rows.map(([regime, stats]) => (
          <div key={regime}>
            <div
              className={cn("text-[11px] font-medium", REGIME_CLASS[regime] ?? "text-foreground")}
            >
              {t(`${n}regime.${regime}`, regime)}
            </div>
            <div className={cn("num text-sm font-bold", rTone(stats.totalR))}>
              {stats.totalR.toFixed(2)}R
            </div>
            <div className="num text-[10px] text-muted-foreground">
              {t(`${n}byRegime.detail`, {
                count: stats.filled,
                win: Math.round(stats.winRate * 100),
                avg: stats.averageR.toFixed(2),
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">{t(`${n}byRegime.note`)}</p>
    </div>
  );
}

/** Measures a container so the curve can be drawn in real pixels.
 *
 * A stretched viewBox would have been less code and would have distorted every
 * stroke and dot with it; the width is cheap to observe and the geometry stays
 * honest. */
function useMeasuredWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface EquityPoint {
  equity: number;
  pnl: number;
  symbol: string;
  mode: string;
  r: number;
}

/** The account curve: one series, so no legend — the panel title names it.
 *
 * Reference lines carry the two things a curve alone cannot say: where the
 * account started (so above/below is readable without arithmetic) and how deep
 * the worst run got. */
function EquityCurve({ start, points }: { start: number; points: EquityPoint[] }) {
  const { t } = useTranslation();
  const n = "routes.forwardTest.";
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const height = 148;
  const padY = 12;
  const series = [start, ...points.map((point) => point.equity)];
  const low = Math.min(...series);
  const high = Math.max(...series);
  const span = high - low || Math.abs(high) || 1;
  const x = (index: number) => (series.length < 2 ? width : (index / (series.length - 1)) * width);
  const y = (value: number) => padY + (1 - (value - low) / span) * (height - padY * 2);

  const up = series[series.length - 1] >= start;
  const line = series.map((value, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`);
  const area = `${line.join(" ")} L${x(series.length - 1)},${height} L0,${height} Z`;
  const active = hover !== null ? Math.min(Math.max(hover, 0), points.length - 1) : null;

  return (
    <div className="relative mt-4" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={t(`${n}sim.curveLabel`)}
        className="block touch-none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - bounds.left) / (bounds.width || 1);
          setHover(Math.round(ratio * (series.length - 1)) - 1);
        }}
      >
        {width > 0 && (
          <>
            {/* Starting capital: the only grid line that means anything here. */}
            <line
              x1={0}
              x2={width}
              y1={y(start)}
              y2={y(start)}
              className="stroke-border"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <path d={area} className={up ? "fill-bullish-soft" : "fill-bearish-soft"} />
            <path
              d={line.join(" ")}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              className={up ? "stroke-bullish" : "stroke-bearish"}
            />
            {active !== null && (
              <line
                x1={x(active + 1)}
                x2={x(active + 1)}
                y1={padY}
                y2={height - padY}
                className="stroke-muted-foreground/50"
                strokeWidth={1}
              />
            )}
            {/* The end of the run is the number people came for. */}
            <circle
              cx={x(series.length - 1)}
              cy={y(series[series.length - 1])}
              r={4}
              className={cn("stroke-card", up ? "fill-bullish" : "fill-bearish")}
              strokeWidth={2}
            />
            {active !== null && (
              <circle
                cx={x(active + 1)}
                cy={y(points[active].equity)}
                r={4}
                className={cn(
                  "stroke-card",
                  points[active].pnl >= 0 ? "fill-bullish" : "fill-bearish",
                )}
                strokeWidth={2}
              />
            )}
          </>
        )}
      </svg>

      {active !== null && width > 0 && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-max max-w-[180px] rounded-md border border-border bg-card px-2 py-1.5 text-[10px] shadow-lg"
          style={{
            left: Math.min(Math.max(x(active + 1) - 60, 0), Math.max(width - 130, 0)),
          }}
        >
          <div className="font-semibold">
            {points[active].symbol}
            <span className="ml-1 font-normal uppercase text-muted-foreground">
              {points[active].mode}
            </span>
          </div>
          <div className="num mt-0.5 flex gap-2">
            <span className={rTone(points[active].r)}>{points[active].r.toFixed(2)}R</span>
            <span className={rTone(points[active].pnl)}>
              {points[active].pnl >= 0 ? "+" : "−"}${Math.abs(points[active].pnl).toFixed(2)}
            </span>
          </div>
          <div className="num mt-0.5 text-muted-foreground">
            {t(`${n}sim.tradeOf`, { index: active + 1, total: points.length })} · $
            {points[active].equity.toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
}

/** One figure in the result strip. Value first, label under it — the strip is
 * scanned, not read. */
function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-surface px-3 py-2">
      <div className={cn("num text-lg font-bold tabular-nums", tone)}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

const RISK_PRESETS = [0.5, 1, 2, 3];

/** What the recorded sequence would have done to an account.
 *
 * Deliberately the plainest model there is: fixed fractional risk, one
 * position's R at a time, in settlement order. It answers "what does this
 * expectancy mean in money" and nothing else — it is not a backtest, it does
 * not compound within a trade, and it cannot tell you what the next hundred
 * setups will do.
 *
 * R is already net of fees and slippage (charged at settlement in
 * `forward_test.py`), so the money here is net too — no second deduction.
 *
 * The honest caveats live under it, not in a footnote nobody reads: the
 * sequence includes positions that overlapped in time, so the drawdown a real
 * account would have felt is *worse* than the one shown here, where losses are
 * suffered one after another.
 */
function Simulator({ setups }: { setups: ForwardTestSetup[] }) {
  const { t } = useTranslation();
  const n = "routes.forwardTest.";
  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(1);

  const result = useMemo(() => {
    const settled = setups
      .filter((s) => s.settledAt !== null && s.status !== "NO_FILL")
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    let equity = capital;
    let peak = capital;
    let maxDrawdown = 0;
    let worst = 0;
    let best = 0;
    let repeats = 0;
    const seen = new Set<string>();
    const points: EquityPoint[] = [];
    for (const setup of settled) {
      // Risk is a fraction of *current* equity: the same rule a person would
      // actually follow, and the one that makes order matter.
      const pnl = ((equity * riskPct) / 100) * setup.realizedR;
      equity += pnl;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
      worst = Math.min(worst, pnl);
      best = Math.max(best, pnl);
      if (seen.has(setup.symbol)) repeats += 1;
      seen.add(setup.symbol);
      points.push({ equity, pnl, symbol: setup.symbol, mode: setup.mode, r: setup.realizedR });
    }
    return {
      trades: settled.length,
      equity,
      change: capital > 0 ? (equity - capital) / capital : 0,
      maxDrawdown,
      worst,
      best,
      repeats,
      points,
    };
  }, [setups, capital, riskPct]);

  const money = (value: number) =>
    `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  // Rendered even with nothing to compute. Hiding it was worse: the cohort you
  // land on by default has no settled rows yet, so the panel simply vanished
  // and looked missing rather than empty.
  const empty = result.trades === 0;
  const dash = "—";

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{t(`${n}sim.title`)}</h2>
        <p className="text-[11px] text-muted-foreground">{t(`${n}sim.lede`)}</p>
      </header>

      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-border pb-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t(`${n}sim.capital`)}
          </span>
          <span className="flex items-center rounded-md border border-border bg-surface focus-within:border-foreground/40">
            <span className="pl-2 text-xs text-muted-foreground">$</span>
            <input
              type="number"
              min={1}
              step={100}
              value={capital}
              onChange={(event) => setCapital(Math.max(1, Number(event.target.value) || 0))}
              className="num w-24 bg-transparent px-1.5 py-1 text-sm font-semibold outline-none"
            />
          </span>
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t(`${n}sim.risk`)}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="flex items-center rounded-md border border-border bg-surface focus-within:border-foreground/40">
              <input
                type="number"
                min={0.1}
                max={100}
                step={0.25}
                value={riskPct}
                onChange={(event) => setRiskPct(Math.max(0.1, Number(event.target.value) || 0))}
                className="num w-14 bg-transparent px-1.5 py-1 text-sm font-semibold outline-none"
              />
              <span className="pr-2 text-xs text-muted-foreground">%</span>
            </span>
            {RISK_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setRiskPct(preset)}
                aria-pressed={riskPct === preset}
                className={cn(
                  "num rounded-md border px-1.5 py-1 text-[11px] transition-colors",
                  riskPct === preset
                    ? "border-foreground/40 bg-surface font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {preset}%
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric
          label={t(`${n}sim.ending`)}
          value={empty ? dash : money(result.equity)}
          tone={empty ? undefined : rTone(result.change)}
        />
        <Metric
          label={t(`${n}sim.change`)}
          value={
            empty ? dash : `${result.change >= 0 ? "+" : ""}${(result.change * 100).toFixed(1)}%`
          }
          tone={empty ? undefined : rTone(result.change)}
        />
        <Metric
          label={t(`${n}sim.drawdown`)}
          value={empty ? dash : `−${(result.maxDrawdown * 100).toFixed(1)}%`}
          tone={empty || result.maxDrawdown === 0 ? undefined : "text-bearish"}
        />
        <Metric
          label={t(`${n}sim.extremes`)}
          value={empty ? dash : `${money(result.best)} / ${money(result.worst)}`}
        />
      </div>

      {!empty && <EquityCurve start={capital} points={result.points} />}

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        {empty ? t(`${n}sim.emptyNote`) : t(`${n}sim.note`, { trades: result.trades })}
        {!empty && result.repeats > 0 && ` ${t(`${n}sim.overlapNote`, { count: result.repeats })}`}
      </p>
    </section>
  );
}

function ForwardTestPage() {
  const { t } = useTranslation();
  const n = "routes.forwardTest.";
  const [mode, setMode] = useState<string | null>(null);
  const [status, setStatus] = useState<ForwardTestStatus | null>(null);
  // Cohorts are never pooled by default: rows recorded under different capture
  // or settlement rules are different experiments. `0` asks for all of them
  // anyway, which is a read, not a merge — the table stays per-row.
  const [allCohorts, setAllCohorts] = useState(false);
  const { data, loading } = useForwardTest(mode, status, allCohorts ? 0 : null);
  const now = useNow();

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

        <button
          type="button"
          onClick={() => setAllCohorts((value) => !value)}
          aria-pressed={allCohorts}
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
            allCohorts
              ? "border-warning/50 bg-warning/10 text-warning"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`${n}cohort.${allCohorts ? "all" : "current"}`)}
        </button>

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

      {data !== null && <Simulator setups={data.setups} />}

      {data !== null && <ByRegime byRegime={data.byRegime} />}

      {data !== null && <Variants setups={data.setups} />}

      {allCohorts && (
        <p className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-[10px] text-warning">
          {t(`${n}cohort.warning`)}
        </p>
      )}

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
                <Row key={setup.id} setup={setup} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">{t(`${n}disclaimer`)}</p>
    </div>
  );
}
