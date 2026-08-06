import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
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

export const Route = createFileRoute("/regime")({
  head: () => ({
    meta: [
      { title: "Market Regime — Market Pulse" },
      {
        name: "description",
        content: "Today's market regime: trend, breadth, volatility, liquidity, and macro.",
      },
      { property: "og:title", content: "Market Regime — Market Pulse" },
      { property: "og:description", content: "Is it Risk On, Risk Off, or Neutral today?" },
    ],
  }),
  component: RegimePage,
});

const TOUR_SEEN_KEY = "iq-regime-tour-v1";

function useTourSteps(): TourStep[] {
  const { t } = useTranslation();
  return (["current", "timeline", "pillars"] as const).map((target) => ({
    target,
    title: t(`routes.regime.tour.${target}.title`),
    body: t(`routes.regime.tour.${target}.body`),
  }));
}

// The regime string itself is the engine's raw value; only the display label is translated.
const REGIME_LABEL_KEY: Record<string, string> = {
  "Risk On": "riskOn",
  Neutral: "neutral",
  "Risk Off": "riskOff",
};

function RegimePage() {
  const { t } = useTranslation();
  const { data } = useRegime();
  const tour = useProductTour(TOUR_SEEN_KEY);
  const tourSteps = useTourSteps();
  const tone =
    data?.regime === "Risk On" ? "bullish" : data?.regime === "Risk Off" ? "bearish" : "warning";
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6">
      <PageHeader
        eyebrow={t("routes.regime.eyebrow")}
        title={t("routes.regime.title")}
        subtitle={t("routes.regime.subtitle")}
        action={<HelpButton onClick={tour.start} />}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {data ? (
          <IqCard data-tour="current" className="flex flex-col items-center gap-4 text-center">
            <CardEyebrow>{t("routes.regime.currentRegime")}</CardEyebrow>
            <ConfidenceGauge value={data.confidence} size={200} label={t("routes.regime.confidence")} />
            <p className="text-xs text-muted-foreground">{t("routes.regime.confidenceNote")}</p>
            <div
              className={
                tone === "bullish"
                  ? "text-3xl font-semibold tracking-tight text-bullish"
                  : tone === "bearish"
                    ? "text-3xl font-semibold tracking-tight text-bearish"
                    : "text-3xl font-semibold tracking-tight text-warning"
              }
            >
              {t(`outlook.${REGIME_LABEL_KEY[data.regime] ?? "neutral"}`)}
            </div>
            <StatusBadge tone={tone}>
              {t("routes.regime.trendStrength", { value: data.trendStrength })}
            </StatusBadge>
          </IqCard>
        ) : (
          <SkeletonCard height={340} />
        )}

        {data ? (
          <IqCard data-tour="timeline" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <CardEyebrow>{t("routes.regime.regimeTimeline")}</CardEyebrow>
              <span className="text-xs text-muted-foreground">{t("routes.regime.last60Sessions")}</span>
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
              <span>{t("outlook.riskOff")}</span>
              <span>{t("outlook.neutral")}</span>
              <span>{t("outlook.riskOn")}</span>
            </div>
          </IqCard>
        ) : (
          <SkeletonCard height={340} />
        )}
      </div>

      <div data-tour="pillars">
        <CardEyebrow>{t("routes.regime.regimePillars")}</CardEyebrow>
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
                  {t(`status.${p.status}`, p.status)}
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

      <ProductTour steps={tourSteps} open={tour.open && !!data} onClose={tour.close} />
    </div>
  );
}
