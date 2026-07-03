import { createFileRoute } from "@tanstack/react-router";
import { useRegime } from "@/hooks/queries";
import { PageHeader } from "@/components/iq/page-header";
import { ConfidenceGauge } from "@/components/iq/confidence-gauge";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { SkeletonCard } from "@/components/iq/skeletons";
import { StatusBadge } from "@/components/iq/status-badge";
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from "recharts";

export const Route = createFileRoute("/regime")({
  head: () => ({
    meta: [
      { title: "Market Regime — IQ" },
      { name: "description", content: "Today's market regime: trend, breadth, volatility, liquidity, and macro." },
      { property: "og:title", content: "Market Regime — IQ" },
      { property: "og:description", content: "Is it Risk On, Risk Off, or Neutral today?" },
    ],
  }),
  component: RegimePage,
});

function RegimePage() {
  const { data } = useRegime();
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6">
      <PageHeader eyebrow="Regime" title="Market Regime" subtitle="How the market is behaving right now." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {data ? (
          <IqCard className="flex flex-col items-center gap-4 text-center">
            <CardEyebrow>Current Regime</CardEyebrow>
            <ConfidenceGauge value={data.confidence} size={200} label="Confidence" />
            <div className="text-3xl font-semibold tracking-tight text-bullish">{data.regime}</div>
            <StatusBadge tone="bullish">Trend Strength · {data.trendStrength}</StatusBadge>
          </IqCard>
        ) : (
          <SkeletonCard height={340} />
        )}

        {data ? (
          <IqCard className="flex flex-col gap-3">
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

      <div>
        <CardEyebrow>Regime Pillars</CardEyebrow>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {data?.pillars.map((p) => (
            <IqCard key={p.label} interactive className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{p.label}</span>
                <StatusBadge tone={p.status === "bullish" ? "bullish" : p.status === "bearish" ? "bearish" : "warning"}>
                  {p.status}
                </StatusBadge>
              </div>
              <div className="num text-2xl font-semibold tracking-tight">{p.score}</div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-bullish"
                  style={{ width: `${p.score}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{p.description}</p>
            </IqCard>
          ))}
        </div>
      </div>
    </div>
  );
}
