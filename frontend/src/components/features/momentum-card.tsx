import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AssetIcon } from "@/components/features/asset-icon";
import {
  ago,
  directionClass,
  eventMagnitude,
  formatMult,
  formatPct,
  formatPrice,
  formatVolume,
} from "@/components/features/momentum-format";
import { MomentumTimeline } from "@/components/features/momentum-timeline";
import type { RadarEntry, RadarEvent, RadarState } from "@/hooks/useMomentumRadar";
import { cn } from "@/lib/utils";

/**
 * One situation, sized to be read in a second or two.
 *
 * The card shows what the situation *is*, and that changes with its lifecycle
 * state rather than with the tape:
 *
 *   NEW / DEVELOPING       the event, its size, and the context it happened in
 *   PULLBACK               how deep, on what volume, structure intact or not
 *   PULLBACK_COMPLETION    the evidence checklist, and the structural path
 *   CONTINUATION_CANDIDATE the leg resuming, with the path still in view
 *
 * Everything durable is large; realtime flow is small and last. There is no
 * generated prose, no score presented as certainty, and nothing that says long
 * or short — a completion card showing 5.4R is describing geometry, not
 * recommending a trade.
 */

const STATE_TONE: Record<RadarState, "bull" | "bear" | "neutral" | "warn"> = {
  NEW: "neutral",
  DEVELOPING: "neutral",
  PULLBACK: "warn",
  PULLBACK_COMPLETION: "bull",
  CONTINUATION_CANDIDATE: "bull",
  INVALID: "neutral",
  STALE: "neutral",
};

const TONE_CLASS: Record<"bull" | "bear" | "neutral" | "warn", { dot: string; text: string }> = {
  bull: { dot: "bg-bullish", text: "text-bullish" },
  bear: { dot: "bg-bearish", text: "text-bearish" },
  warn: { dot: "bg-warning", text: "text-warning" },
  neutral: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

const CONTEXT_CLASS: Record<string, string> = {
  bullish: "text-bullish",
  bearish: "text-bearish",
  neutral: "text-muted-foreground",
  mixed: "text-warning",
  unknown: "text-muted-foreground",
};

const ALIGNMENT_CLASS: Record<string, string> = {
  aligned: "text-bullish",
  counter_trend: "text-warning",
  mixed: "text-muted-foreground",
  unclassified: "text-muted-foreground",
};

/** Evidence quality, shown instead of a bare number. A tier is honest about
 * what it is — a bucket derived from how much independent evidence agrees —
 * whereas "95/100" implies a precision the detector has not earned. */
const TIER_CLASS: Record<string, string> = {
  HIGH: "border-bullish/40 bg-bullish-soft text-bullish",
  MEDIUM: "border-info/40 bg-info-soft text-info",
  LOW: "border-border bg-surface text-muted-foreground",
  NONE: "border-border bg-surface text-muted-foreground",
};

const PATH_CLASS: Record<string, string> = {
  WORTH_WATCHING: "text-bullish",
  THIN: "text-warning",
  SKIP: "text-muted-foreground",
};

/**
 * Card colour. The lifecycle state leads, then direction — except for a
 * counter-trend event, which stays amber: a bearish burst inside a bullish
 * regime is a different thing from one inside a bearish regime, and the colour
 * should not imply otherwise.
 */
function toneFor(
  state: RadarState,
  headline: RadarEvent | null,
  classification: string,
): "bull" | "bear" | "neutral" | "warn" {
  if (classification === "counter_trend") return "warn";
  const base = STATE_TONE[state] ?? "neutral";
  if (base === "warn") return "warn";
  if (headline?.direction === "bullish") return "bull";
  if (headline?.direction === "bearish") return "bear";
  return base;
}

function Metric({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className="min-w-0">
      <div className={cn("num text-sm font-semibold tabular-nums", className)}>{value}</div>
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

/** The completion checklist. Every item travels, including the misses — the
 * point is that the reasoning is inspectable, not that it looks convincing. */
function Evidence({ entry }: { entry: RadarEntry }) {
  const { t } = useTranslation();
  const n = "components.momentum.";
  const items = entry.completion?.evidence.filter((item) => item.met) ?? [];
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 space-y-0.5">
      {items.map((item) => (
        <li key={item.code} className="flex items-baseline gap-1.5 text-[11px]">
          <span className="text-bullish">✓</span>
          <span className="min-w-0 flex-1 truncate">
            {t(`${n}evidence.${item.code}`, { defaultValue: item.code })}
          </span>
          <span className="num shrink-0 text-muted-foreground">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Entry / invalidation / target, and the ratio between them. A filter that
 * this situation passed — never an instruction. */
function Path({ entry }: { entry: RadarEntry }) {
  const { t } = useTranslation();
  const n = "components.momentum.";
  const path = entry.path;
  if (path === null) return null;
  return (
    <div className="mt-2 rounded border border-border/70 bg-surface px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t(`${n}potentialPath`)}
        </span>
        <span className={cn("num text-sm font-bold", PATH_CLASS[path.verdict] ?? "")}>
          {path.rr.toFixed(1)}R
        </span>
      </div>
      <div className="num mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
        <span>
          {t(`${n}entryZone`)} {formatPrice(path.entry)}
        </span>
        <span>
          {t(`${n}invalidation`)} {formatPrice(path.invalidation)}
        </span>
        <span>
          {t(`${n}target`)} {formatPrice(path.target)}
          {path.targetKind !== "" && (
            <span className="ml-1">
              ({t(`${n}level.${path.targetKind}`, { defaultValue: path.targetKind })})
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function MomentumCard({
  entry,
  now,
  expanded = false,
  onToggle,
}: {
  entry: RadarEntry;
  now: number;
  expanded?: boolean;
  onToggle?: (symbol: string) => void;
}) {
  const { t } = useTranslation();
  const n = "components.momentum.";
  const headline = entry.headline;
  const closed = entry.state === "INVALID" || entry.state === "STALE";
  const tone = TONE_CLASS[toneFor(entry.state, headline, entry.alignment.classification)];

  const developing = entry.state === "PULLBACK";
  const completing =
    entry.state === "PULLBACK_COMPLETION" || entry.state === "CONTINUATION_CANDIDATE";

  // The move that goes with the event: the primary window normally, the fast
  // one when the headline is a fast structural read.
  const fastHeadline = headline?.type === "CHOCH" || headline?.type === "CONTINUATION";
  const scalp = entry.mode === "SCALP";
  const movePct = fastHeadline
    ? scalp
      ? entry.telemetry.change1mPct
      : entry.telemetry.change5mPct
    : scalp
      ? entry.telemetry.change3mPct
      : entry.telemetry.change15mPct;
  const moveLabel = fastHeadline ? (scalp ? "1m" : "5m") : scalp ? "3m" : "15m";
  const rvol = scalp ? (entry.telemetry.rvol3m ?? entry.telemetry.rvol1m) : entry.telemetry.rvol5m;

  const context = entry.context;
  const alignment = entry.alignment;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-3 transition-colors",
        closed && "opacity-60",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <AssetIcon ticker={entry.symbol} className="text-sm" />
          <span className="truncate text-sm font-semibold">{entry.symbol}</span>
          <span className="text-[10px] text-muted-foreground">/USDT</span>
        </div>
        <span className="shrink-0 rounded border border-border px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
          {t(`${n}perp`)}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              tone.dot,
              headline?.active === false && "opacity-40",
            )}
          />
          <span
            className={cn("truncate text-[11px] font-semibold uppercase tracking-wide", tone.text)}
          >
            {developing || completing
              ? t(`${n}state.${entry.state}`)
              : headline === null
                ? t(`${n}event.NONE`)
                : t(`${n}event.${headline.type}`, { defaultValue: headline.type })}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            TIER_CLASS[entry.tier] ?? TIER_CLASS.NONE,
          )}
          title={t(`${n}tierTooltip`, {
            score: Math.round(entry.score),
            families: entry.families.join(" + ") || "—",
          })}
        >
          {t(`${n}tier.${entry.tier}`, { defaultValue: entry.tier })}
        </span>
      </div>

      {developing && entry.pullback !== null ? (
        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
          <Metric
            value={`${entry.pullback.retracePct.toFixed(1)}%`}
            label={t(`${n}retracement`)}
            className="text-muted-foreground"
          />
          <Metric
            value={formatMult(entry.pullback.volumeRatio)}
            label={t(`${n}pullbackVolume`)}
            className={
              (entry.pullback.volumeRatio ?? 9) <= 1 ? "text-bullish" : "text-muted-foreground"
            }
          />
        </div>
      ) : (
        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
          <Metric
            value={`${formatPct(movePct)} / ${moveLabel}`}
            label={t(`${n}move`)}
            className={directionClass(movePct)}
          />
          <Metric
            value={`${formatMult(rvol)} ${t(`${n}rvol`)}`}
            label={t(`${n}relativeVolume`)}
            className={(rvol ?? 0) >= 2 ? "text-foreground" : "text-muted-foreground"}
          />
        </div>
      )}

      <div className="mt-2.5 space-y-0.5 text-[11px]">
        <div className={tone.text}>
          {entry.direction === null
            ? t(`${n}classification.undirected`)
            : t(`${n}classification.${entry.direction}`)}
          {headline !== null && headline.unit !== "" && !developing && (
            <span className="num ml-1 text-muted-foreground">{eventMagnitude(headline)}</span>
          )}
        </div>

        {entry.combo !== "" && (
          <div className="text-muted-foreground">
            {t(`${n}combo.${entry.combo}`, { defaultValue: entry.combo })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-2">
          <span className="text-muted-foreground">
            {t(`${n}htf`)}{" "}
            <span className={cn("font-medium", CONTEXT_CLASS[context?.bias ?? "unknown"])}>
              {context === null
                ? t(`${n}context.pending`)
                : t(`${n}context.${context.bias}`, { defaultValue: context.bias })}
            </span>
          </span>
          <span className="text-muted-foreground">
            {t(`${n}alignment.label`)}{" "}
            <span className={cn("font-medium", ALIGNMENT_CLASS[alignment.classification])}>
              {t(`${n}alignment.${alignment.level}`, { defaultValue: alignment.level })}
            </span>
          </span>
          {developing && entry.pullback !== null && (
            <span className="text-muted-foreground">
              {t(`${n}structure`)}{" "}
              <span
                className={cn(
                  "font-medium",
                  entry.pullback.structureIntact ? "text-bullish" : "text-bearish",
                )}
              >
                {t(entry.pullback.structureIntact ? `${n}intact` : `${n}broken`)}
              </span>
            </span>
          )}
        </div>

        <div className="text-muted-foreground">
          {headline === null
            ? t(`${n}noEvent`)
            : t(`${n}detected`, { ago: ago(now - headline.ts) })}
          {headline?.active === false && <span className="ml-1">· {t(`${n}cooling`)}</span>}
        </div>
      </div>

      {completing && <Evidence entry={entry} />}
      {(completing || developing) && <Path entry={entry} />}

      {/* Secondary telemetry: real, useful, and deliberately not the headline. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="num">{formatVolume(entry.telemetry.quoteVolume24h)} / 24h</span>
        {entry.telemetry.tradeRateMult !== null && (
          <span className="num">
            {formatMult(entry.telemetry.tradeRateMult)} {t(`${n}tradeRate`)}
          </span>
        )}
        {entry.telemetry.pressure !== "" && (
          <span className="capitalize">{entry.telemetry.pressure}</span>
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <Link
          to="/token/$symbol"
          params={{ symbol: entry.symbol }}
          className="text-[11px] font-medium text-foreground hover:underline"
        >
          {t(`${n}viewStructure`)} →
        </Link>
        {onToggle !== undefined && (
          <button
            type="button"
            onClick={() => onToggle(entry.symbol)}
            aria-expanded={expanded}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? t(`${n}hideTimeline`) : t(`${n}showTimeline`)}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 border-t border-border pt-2">
          <MomentumTimeline
            symbol={entry.symbol}
            mode={entry.mode}
            fallback={entry.timeline}
            now={now}
          />
        </div>
      )}
    </div>
  );
}
