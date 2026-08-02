import { memo, useState } from "react";

import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { MiniChart } from "@/components/features/mini-chart";
import { Badge } from "@/components/ui/badge";
import {
  useDerivatives,
  useDerivativesHistory,
  type CrowdingBand,
  type DerivativesIntelligence,
  type DerivativesMetric,
  type DerivativesWindow,
  type MarketRegime,
  type OiExpansion,
} from "@/hooks/useDerivatives";
import { cn } from "@/lib/utils";

/**
 * Derivatives Intelligence — the positioning read on the Ticket page.
 *
 * Deliberately NOT a Binance-style metrics table. Every card leads with what
 * the number means ("82 · Bullish Expansion"), and every label, band, score
 * and sentence arrives finished from `/api/derivatives`. This file computes
 * nothing but colour.
 */

type Tone = "bullish" | "bearish" | "neutral";

const WINDOWS: readonly DerivativesWindow[] = ["5m", "1h", "4h", "24h"];

const WINDOW_LABEL: Record<DerivativesWindow, string> = {
  "5m": "5 mnt",
  "1h": "1 jam",
  "4h": "4 jam",
  "24h": "24 jam",
};

const REGIME_TONE: Record<MarketRegime, Tone> = {
  strong_bull_trend: "bullish",
  weak_bull_trend: "bullish",
  strong_bear_trend: "bearish",
  weak_bear_trend: "bearish",
  short_squeeze: "bullish",
  long_squeeze: "bearish",
  distribution: "bearish",
  accumulation: "bullish",
  neutral: "neutral",
};

const EXPANSION_TONE: Record<OiExpansion, Tone> = {
  bullish_expansion: "bullish",
  short_covering: "neutral",
  bearish_expansion: "bearish",
  long_capitulation: "neutral",
  neutral: "neutral",
};

const CROWDING_TONE: Record<CrowdingBand, Tone> = {
  bullish_crowded: "bearish", // a crowded long book is a risk, not a green light
  bearish_crowded: "bullish",
  balanced: "neutral",
  unknown: "neutral",
};

const TONE_TEXT: Record<Tone, string> = {
  bullish: "text-bullish",
  bearish: "text-bearish",
  neutral: "text-muted-foreground",
};

function scoreTone(score: number | null): Tone {
  if (score === null) return "neutral";
  if (score >= 60) return "bullish";
  if (score <= 40) return "bearish";
  return "neutral";
}

function formatScore(score: number | null): string {
  return score === null ? "–" : String(Math.round(score));
}

interface MetricCardProps {
  label: string;
  value: string;
  reading: string;
  tone: Tone;
  symbol?: string;
  metric?: DerivativesMetric;
  window?: DerivativesWindow;
}

const MetricCard = memo(function MetricCard({
  label,
  value,
  reading,
  tone,
  symbol,
  metric,
  window,
}: MetricCardProps) {
  // Only the four cards that pass a metric get a series; the query is disabled
  // for the rest rather than fetched and thrown away.
  const history = useDerivativesHistory(
    symbol ?? "",
    metric ?? "momentum",
    window ?? "1h",
    Boolean(symbol && metric),
  );
  const points = history.data?.points ?? [];

  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-surface/40 p-3">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("mt-1 text-lg font-semibold tabular-nums", TONE_TEXT[tone])}>
        {value}
      </span>
      <span className="mt-0.5 truncate text-xs text-muted-foreground" title={reading}>
        {reading}
      </span>
      {metric ? (
        <div className="mt-2">
          {points.length > 1 ? (
            <MiniChart data={points} tone={tone} height={28} />
          ) : (
            <div className="h-[28px] text-[10px] leading-[28px] text-muted-foreground">
              {history.isLoading ? "Memuat…" : "Belum cukup titik data"}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});

const DerivativesCards = memo(function DerivativesCards({
  symbol,
  data,
  window,
}: {
  symbol: string;
  data: DerivativesIntelligence;
  window: DerivativesWindow;
}) {
  const { derived, intelligence, scores } = data;
  const aggression = derived.buyer_aggression;

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
      <MetricCard
        label="Momentum"
        value={formatScore(scores.momentum)}
        reading={intelligence.expansion_label}
        tone={scoreTone(scores.momentum)}
        symbol={symbol}
        metric="momentum"
        window={window}
      />
      <MetricCard
        label="Buyer Aggression"
        value={aggression === null ? "–" : `${Math.round(aggression * 100)}%`}
        reading={intelligence.aggression_label}
        tone={aggression === null ? "neutral" : scoreTone(aggression * 100)}
        symbol={symbol}
        metric="buyer_aggression"
        window={window}
      />
      <MetricCard
        label="Funding"
        value={
          derived.funding_trend.current === null
            ? "–"
            : `${(derived.funding_trend.current * 100).toFixed(4)}%`
        }
        reading={intelligence.funding_label}
        tone={
          derived.funding_trend.current === null
            ? "neutral"
            : derived.funding_trend.current > 0
              ? "bullish"
              : derived.funding_trend.current < 0
                ? "bearish"
                : "neutral"
        }
        symbol={symbol}
        metric="funding"
        window={window}
      />
      <MetricCard
        label="Open Interest"
        value={derived.oi_delta["1h"] === null ? "–" : `${derived.oi_delta["1h"].toFixed(1)}%`}
        reading={intelligence.oi_label}
        tone={EXPANSION_TONE[derived.oi_expansion]}
        symbol={symbol}
        metric="oi"
        window={window}
      />
      <MetricCard
        label="Crowding"
        value={formatScore(scores.crowding)}
        reading={intelligence.crowding_label}
        tone={CROWDING_TONE[derived.crowding_band]}
      />
      <MetricCard
        label="Squeeze Risk"
        value={`L ${Math.round(scores.squeeze.long)} · S ${Math.round(scores.squeeze.short)}`}
        reading={intelligence.squeeze_label}
        tone={
          scores.squeeze.long > scores.squeeze.short
            ? "bearish"
            : scores.squeeze.short > scores.squeeze.long
              ? "bullish"
              : "neutral"
        }
      />
    </div>
  );
});

export function DerivativesIntelligenceSection({ symbol }: { symbol: string }) {
  const [window, setWindow] = useState<DerivativesWindow>("1h");
  const query = useDerivatives(symbol);
  const data = query.data;

  return (
    <IqCard className="mx-3 shrink-0 sm:mx-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CardEyebrow>Derivatives Intelligence</CardEyebrow>
          {data ? (
            <Badge variant="outline" className={TONE_TEXT[REGIME_TONE[data.regime]]}>
              {data.intelligence.regime_label}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setWindow(option)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] transition-colors",
                option === window
                  ? "bg-surface text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {WINDOW_LABEL[option]}
            </button>
          ))}
        </div>
      </div>

      {query.isLoading ? (
        <p className="mt-2 text-xs text-muted-foreground">Memuat data derivatif…</p>
      ) : null}

      {!query.isLoading && !data ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Belum ada data derivatif untuk {symbol}. Kolektor berjalan tiap 5 menit setelah
          diaktifkan.
        </p>
      ) : null}

      {data ? (
        <>
          <p className="mt-2 text-sm leading-relaxed text-foreground">
            {data.intelligence.summary}
          </p>
          <DerivativesCards symbol={symbol} data={data} window={window} />
          <p className="mt-2 text-[11px] text-muted-foreground">
            {data.derived.sample_count} sampel · pembaruan terakhir{" "}
            {new Date(data.raw.timestamp).toLocaleTimeString("id-ID", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </>
      ) : null}
    </IqCard>
  );
}
