import { useRegime } from "@/hooks/queries";
import { PageHeader } from "@/components/features/page-header";
import { ConfidenceGauge } from "@/components/features/confidence-gauge";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { SkeletonCard } from "@/components/features/skeletons";
import { StatusBadge } from "@/components/features/status-badge";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from "recharts";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";

const TOUR_SEEN_KEY = "iq-regime-tour-v1";

const TOUR_STEPS: TourStep[] = [
  {
    target: "current",
    title: "The current regime",
    body: "One answer to the day's most important question: is the market rewarding risk (Risk On), punishing it (Risk Off), or undecided (Neutral)? The gauge shows how confident the model is — trade smaller when confidence is low.",
  },
  {
    target: "timeline",
    title: "Regime timeline",
    body: "The regime score over the last 60 sessions. Above the upper dashed line is Risk On territory, below the lower one is Risk Off. A score that keeps crossing the lines means an unstable, choppy market.",
  },
  {
    target: "pillars",
    title: "The five pillars",
    body: "What the regime verdict is built from: trend, breadth, volatility, liquidity, and macro — each scored 0–100. When pillars disagree (say, trend bullish but breadth bearish), treat the overall regime with more caution.",
  },
];

export function RegimePanel() {
  const { data } = useRegime();
  const tour = useProductTour(TOUR_SEEN_KEY);
  const tone =
    data?.regime === "Risk On" ? "bullish" : data?.regime === "Risk Off" ? "bearish" : "warning";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Regime"
        title="Market Regime"
        subtitle="How the market is behaving right now."
        action={<HelpButton onClick={tour.start} />}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {data ? (
          <IqCard data-tour="current" className="flex flex-col items-center gap-4 text-center">
            <CardEyebrow>Current Regime</CardEyebrow>
            <ConfidenceGauge value={data.confidence} size={200} label="Confidence" />
            <p className="text-xs text-muted-foreground">
              Rule-based blend of the five regime pillars below, not a calibrated probability.
            </p>
            <div
              className={
                tone === "bullish"
                  ? "text-3xl font-semibold tracking-tight text-bullish"
                  : tone === "bearish"
                    ? "text-3xl font-semibold tracking-tight text-bearish"
                    : "text-3xl font-semibold tracking-tight text-warning"
              }
            >
              {data.regime}
            </div>
            <StatusBadge tone={tone}>Trend Strength · {data.trendStrength}</StatusBadge>
          </IqCard>
        ) : (
          <SkeletonCard height={340} />
        )}

        {data ? (
          <IqCard data-tour="timeline" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <CardEyebrow>Regime Timeline</CardEyebrow>
              <span className="text-xs text-muted-foreground">Last 60 sessions</span>
            </div>
            <div className="h-[280px] w-full">
              <ResponsiveContainer>
                <AreaChart data={data.timeline}>
                  <defs>
                    <linearGradient id="regime-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-bullish)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-bullish)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 100]} hide />
                  <ReferenceLine y={60} stroke="var(--color-border)" strokeDasharray="3 3" />
                  <ReferenceLine y={40} stroke="var(--color-border)" strokeDasharray="3 3" />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-popover)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "var(--color-muted-foreground)" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="var(--color-bullish)"
                    strokeWidth={2}
                    fill="url(#regime-fill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Risk Off</span>
              <span>Neutral</span>
              <span>Risk On</span>
            </div>
          </IqCard>
        ) : (
          <SkeletonCard height={340} />
        )}
      </div>

      <div data-tour="pillars">
        <CardEyebrow>Regime Pillars</CardEyebrow>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {data?.pillars.map((p) => (
            <IqCard key={p.label} interactive className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{p.label}</span>
                <StatusBadge
                  tone={
                    p.status === "bullish"
                      ? "bullish"
                      : p.status === "bearish"
                        ? "bearish"
                        : "warning"
                  }
                >
                  {p.status}
                </StatusBadge>
              </div>
              <div className="num text-2xl font-semibold tracking-tight">
                {p.displayValue ?? p.score}
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={
                    p.status === "bullish"
                      ? "h-full rounded-full bg-bullish"
                      : p.status === "bearish"
                        ? "h-full rounded-full bg-bearish"
                        : "h-full rounded-full bg-warning"
                  }
                  style={{ width: `${p.score}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{p.description}</p>
            </IqCard>
          ))}
        </div>
      </div>

      <ProductTour steps={TOUR_STEPS} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}
