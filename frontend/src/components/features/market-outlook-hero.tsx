import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

import { ConfidenceGauge } from "./confidence-gauge";
import { CardEyebrow, IqCard } from "./iq-card";
import { SkeletonCard } from "./skeletons";
import {
  useAssets,
  useEconomicEvents,
  useRegime,
  useRotation,
  useSentiment,
  useTechnicalQuality,
  useVolatility,
} from "@/hooks/queries";
import { buildMarketBrief, type BriefTone } from "@/lib/engine/market-brief";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

/**
 * The above-the-fold answer to "should I trade today?": the regime verdict and
 * its one-line instruction, beside a rule-based brief restating the same
 * snapshot in sentences. The brief is deterministic — the BYOK analyst is the
 * separate "Ask AI" surface, and this panel never claims to be it.
 */

const ACTION_LINE = {
  "Risk On": "Conditions favourable — trade your plan, normal size.",
  Neutral: "Mixed conditions. Be selective, reduce size, and skip low-conviction setups.",
  "Risk Off": "Poor conditions — sit out or scalp only, tight risk.",
} as const;

const TONE_CLASS: Record<BriefTone, string> = {
  bullish: "bg-bullish/70",
  bearish: "bg-bearish/70",
  warning: "bg-warning/70",
  neutral: "bg-muted-foreground/60",
};

export function MarketOutlookHero() {
  const regime = useRegime();
  const rotation = useRotation();
  const sentiment = useSentiment();
  const technical = useTechnicalQuality();
  const volatility = useVolatility();
  const assets = useAssets();
  const calendar = useEconomicEvents(3, "high");
  const setAskAi = useUiStore((s) => s.setAskAi);

  const brief = useMemo(() => {
    if (!regime.data || !rotation.data || !sentiment.data || !technical.data || !volatility.data) {
      return null;
    }
    return buildMarketBrief({
      regime: regime.data,
      rotation: rotation.data,
      sentiment: sentiment.data,
      technical: technical.data,
      volatility: volatility.data,
      upcomingHighImpact: (calendar.data ?? []).map((e) => ({
        title: e.title,
        occursAt: e.occursAt,
      })),
    });
  }, [regime.data, rotation.data, sentiment.data, technical.data, volatility.data, calendar.data]);

  if (!regime.data || !brief) return <SkeletonCard height={260} />;

  const r = regime.data;
  const tone = r.regime === "Risk On" ? "bullish" : r.regime === "Risk Off" ? "bearish" : "warning";
  const btc = assets.data?.find((a) => a.ticker === "BTC");

  return (
    <IqCard
      padded={false}
      className={cn(
        "relative overflow-hidden border",
        tone === "bullish" && "border-bullish/40",
        tone === "bearish" && "border-bearish/40",
        tone === "warning" && "border-warning/40",
      )}
    >
      <div className="grid grid-cols-1 gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        {/* Verdict */}
        <div className="flex flex-col">
          <CardEyebrow>Market Outlook</CardEyebrow>
          <h2
            className={cn(
              "mt-3 text-3xl font-black uppercase tracking-tight sm:text-4xl",
              tone === "bullish" && "text-bullish",
              tone === "bearish" && "text-bearish",
              tone === "warning" && "text-warning",
            )}
          >
            {r.regime}
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {ACTION_LINE[r.regime]}
          </p>
          <div className="mt-5 flex items-center gap-3 self-start rounded-xl border border-border bg-surface/60 py-1.5 pl-4 pr-2">
            <span
              className="text-xs text-muted-foreground"
              title="Rule-based blend of the regime pillars, not a calibrated probability."
            >
              Confidence
            </span>
            <span
              className={cn(
                "num text-sm font-bold",
                tone === "bullish" && "text-bullish",
                tone === "bearish" && "text-bearish",
                tone === "warning" && "text-warning",
              )}
            >
              {r.confidence}%
            </span>
            <ConfidenceGauge
              value={r.confidence}
              size={30}
              showValue={false}
              tone={`var(--color-${tone})`}
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {r.pillars.slice(0, 3).map((p) => (
              <span
                key={p.label}
                title={p.description}
                className="rounded-md border border-border bg-background/40 px-2 py-1 text-[11px] text-muted-foreground"
              >
                {p.label}:{" "}
                <span className="font-semibold text-foreground">
                  {p.displayValue || `${p.score}%`}
                </span>
              </span>
            ))}
          </div>
        </div>

        {/* Brief */}
        <div className="relative flex flex-col">
          {btc && btc.spark.length > 1 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-0 h-32 opacity-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={btc.spark} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="outlook-spark" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-warning)" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="var(--color-warning)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <YAxis hide domain={["dataMin", "dataMax"]} />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="var(--color-warning)"
                    strokeWidth={1.5}
                    fill="url(#outlook-spark)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="relative z-10 flex h-full flex-col">
            <div className="flex items-center gap-2">
              <CardEyebrow>Market Brief</CardEyebrow>
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground"
                title="Deterministic restatement of the snapshot — not an LLM summary."
              >
                Rule-based
              </span>
            </div>
            <ul className="mt-3 flex flex-col gap-2">
              {brief.lines.map((line, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={cn(
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                      TONE_CLASS[line.tone],
                    )}
                  />
                  <span className="leading-snug text-muted-foreground">{line.text}</span>
                </li>
              ))}
            </ul>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-5">
              <div className="text-xs">
                <span
                  className={cn(
                    "font-semibold",
                    tone === "bullish" && "text-bullish",
                    tone === "bearish" && "text-bearish",
                    tone === "warning" && "text-warning",
                  )}
                >
                  How to trade it:{" "}
                </span>
                <span className="text-foreground">{brief.recommendation.join(" • ")}</span>
              </div>
              <button
                type="button"
                onClick={() => setAskAi(true)}
                className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface/70"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Ask AI
              </button>
            </div>
          </div>
        </div>
      </div>
    </IqCard>
  );
}
