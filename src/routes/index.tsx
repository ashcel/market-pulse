import { createFileRoute } from "@tanstack/react-router";
import {
  useTopAssets,
  useAssets,
  useRegime,
  useRotation,
  useNews,
  useSectors,
  useSentiment,
  useTechnicalQuality,
  useVolatility,
} from "@/hooks/queries";
import { MetricCard } from "@/components/iq/metric-card";
import { ConfidenceGauge } from "@/components/iq/confidence-gauge";
import { MiniChart } from "@/components/iq/mini-chart";
import { Change } from "@/components/iq/change";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { MarketCard, formatPrice } from "@/components/iq/market-card";
import { NewsImpactCard } from "@/components/iq/news-impact-card";
import { Heatmap } from "@/components/iq/heatmap";
import { AssetIcon } from "@/components/iq/asset-icon";
import { StatusBadge } from "@/components/iq/status-badge";
import { SkeletonCard } from "@/components/iq/skeletons";
import { ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — IQ Market Intelligence" },
      {
        name: "description",
        content:
          "Your morning market briefing: regime, capital rotation, top assets, news, and sector flow.",
      },
      { property: "og:title", content: "Dashboard — IQ Market Intelligence" },
      {
        property: "og:description",
        content: "Understand today's market regime and where capital is flowing.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const greeting = getGreeting();
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {greeting}, Dewi <span aria-hidden>👋</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Here is your market intelligence for today.
          </p>
        </div>
      </header>

      <HeroMetrics />
      <MarketOverviewStrip />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <TopAssets />
        <NewsHighlights />
      </div>

      <CapitalFlowHeatmap />
    </div>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 18) return "Good Afternoon";
  return "Good Evening";
}

function HeroMetrics() {
  const regime = useRegime();
  const rotation = useRotation();
  const sentiment = useSentiment();
  const technical = useTechnicalQuality();
  const volatility = useVolatility();

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      {regime.data ? (
        <MetricCard
          label="Market Regime"
          accent="bullish"
          value={regime.data.regime}
          footerLeft="Confidence"
          footerRight={<span className="num text-bullish">{regime.data.confidence}%</span>}
        >
          <div className="flex justify-end">
            <ConfidenceGauge value={regime.data.confidence} size={64} showValue={false} />
          </div>
        </MetricCard>
      ) : (
        <SkeletonCard />
      )}

      {rotation.data ? (
        <MetricCard
          label="Money Rotation"
          value={
            <div className="flex flex-wrap items-center gap-1 text-lg sm:text-xl">
              {rotation.data.flow.slice(0, 3).map((n, i) => (
                <span key={n} className="flex items-center gap-1">
                  <span className="font-semibold">{n}</span>
                  {i < 2 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
                </span>
              ))}
            </div>
          }
          footerLeft="Rotation Strength"
          footerRight={<span className="text-bullish">{rotation.data.strength}</span>}
        >
          <MiniChart data={miniFor(1)} tone="bullish" height={28} />
        </MetricCard>
      ) : (
        <SkeletonCard />
      )}

      {sentiment.data ? (
        <MetricCard
          label="Sentiment"
          accent="bullish"
          value={sentiment.data.label}
          footerLeft="Score"
          footerRight={
            <span className="num text-foreground">{sentiment.data.score} / 100</span>
          }
        >
          <FearGreed value={sentiment.data.fearGreed} />
        </MetricCard>
      ) : (
        <SkeletonCard />
      )}

      {technical.data ? (
        <MetricCard
          label="Technical Quality"
          accent="bullish"
          value={technical.data.label}
          footerLeft="Trend Strength"
          footerRight={<span className="text-bullish">High</span>}
        >
          <MiniChart data={miniFor(2)} tone="bullish" height={28} />
        </MetricCard>
      ) : (
        <SkeletonCard />
      )}

      {volatility.data ? (
        <MetricCard
          label="Volatility"
          accent="warning"
          value={volatility.data.label}
          footerLeft="VIX"
          footerRight={<span className="num text-foreground">{volatility.data.vix.toFixed(1)}</span>}
        >
          <MiniChart data={volatility.data.spark} tone="bearish" height={28} />
        </MetricCard>
      ) : (
        <SkeletonCard />
      )}
    </div>
  );
}

function FearGreed({ value }: { value: number }) {
  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-bearish via-warning to-bullish">
        <div
          className="absolute -top-1 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-background bg-foreground"
          style={{ left: `${value}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Fear</span>
        <span>Greed</span>
      </div>
    </div>
  );
}

function miniFor(seed: number) {
  const out = [];
  let v = 50;
  for (let i = 0; i < 24; i++) {
    v += (Math.sin(i / 3 + seed) + Math.cos(i / 5 + seed)) * 2;
    out.push({ t: i, v: Number(v.toFixed(2)) });
  }
  return out;
}

function MarketOverviewStrip() {
  const { data } = useAssets();
  const [range, setRange] = useState<"1D" | "7D" | "30D">("1D");

  const shown = data?.filter((a) =>
    ["BTC", "ETH", "SPY", "QQQ", "GOLD", "DXY", "VIX"].includes(a.ticker),
  );

  return (
    <IqCard>
      <div className="flex items-center justify-between">
        <CardEyebrow>Market Overview</CardEyebrow>
        <div className="flex rounded-md border border-border bg-surface p-0.5 text-xs">
          {(["1D", "7D", "30D"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                range === r ? "bg-card text-foreground" : "text-muted-foreground",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {shown
          ? shown.map((a) => (
              <div
                key={a.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">{a.ticker}</span>
                  <Change value={a.change24h} />
                </div>
                <div className="num text-sm">{formatPrice(a.price)}</div>
                <MiniChart data={a.spark} tone={a.change24h >= 0 ? "bullish" : "bearish"} height={32} />
              </div>
            ))
          : Array.from({ length: 7 }).map((_, i) => (
              <SkeletonCard key={i} height={110} />
            ))}
      </div>
    </IqCard>
  );
}

function TopAssets() {
  const { data } = useTopAssets(5);
  return (
    <IqCard padded={false}>
      <div className="flex items-center justify-between p-5 pb-3">
        <CardEyebrow>Top Assets</CardEyebrow>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-5 py-2 text-left font-semibold">#</th>
              <th className="px-2 py-2 text-left font-semibold">Asset</th>
              <th className="px-2 py-2 text-right font-semibold">Price</th>
              <th className="px-2 py-2 text-right font-semibold">24H</th>
              <th className="px-2 py-2 text-right font-semibold">Score</th>
              <th className="hidden px-2 py-2 text-right font-semibold sm:table-cell">Trend</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((a, i) => (
              <tr
                key={a.id}
                className="border-b border-border last:border-0 hover:bg-surface/60"
              >
                <td className="px-5 py-3 text-xs text-muted-foreground">{i + 1}</td>
                <td className="px-2 py-3">
                  <div className="flex items-center gap-2">
                    <AssetIcon ticker={a.ticker} className="h-6 w-6" />
                    <div className="leading-tight">
                      <div className="font-semibold">{a.ticker}</div>
                      <div className="text-[11px] text-muted-foreground">{a.name}</div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-3 text-right num">{formatPrice(a.price)}</td>
                <td className="px-2 py-3 text-right">
                  <Change value={a.change24h} />
                </td>
                <td className="px-2 py-3 text-right num font-semibold">{a.score}</td>
                <td className="hidden px-2 py-3 sm:table-cell">
                  <div className="ml-auto max-w-[120px]">
                    <MiniChart data={a.spark} tone={a.change24h >= 0 ? "bullish" : "bearish"} height={26} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border p-2">
        <Link
          to="/rankings"
          className="flex items-center justify-center rounded-lg py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface hover:text-foreground"
        >
          View All Rankings
        </Link>
      </div>
    </IqCard>
  );
}

function NewsHighlights() {
  const { data } = useNews();
  return (
    <IqCard padded={false} className="flex flex-col">
      <div className="flex items-center justify-between p-5 pb-3">
        <CardEyebrow>News Highlights</CardEyebrow>
        <Link to="/news" className="text-xs font-medium text-info hover:underline">
          View All
        </Link>
      </div>
      <ul className="flex flex-1 flex-col divide-y divide-border">
        {data?.slice(0, 4).map((n) => {
          const impactTone = n.impact === "high" ? "bearish" : n.impact === "medium" ? "warning" : "info";
          return (
            <li key={n.id} className="flex gap-3 px-5 py-3">
              <span
                className={cn(
                  "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                  n.direction === "bullish" && "bg-bullish",
                  n.direction === "bearish" && "bg-bearish",
                  n.direction === "neutral" && "bg-muted-foreground",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-sm font-medium leading-snug">{n.headline}</p>
                  <StatusBadge tone={impactTone}>{n.impact}</StatusBadge>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>Affects:</span>
                  <span className="font-medium text-foreground">{n.assets.slice(0, 4).join(", ")}</span>
                  <span className="ml-auto shrink-0">{n.minutesAgo}m ago</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </IqCard>
  );
}

function CapitalFlowHeatmap() {
  const { data } = useSectors();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <CardEyebrow>Capital Flow Heatmap</CardEyebrow>
        <span className="text-xs text-muted-foreground">1D</span>
      </div>
      {data ? <Heatmap sectors={data} /> : <SkeletonCard height={240} />}
    </div>
  );
}
