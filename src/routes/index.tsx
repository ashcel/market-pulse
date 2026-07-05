import { createFileRoute } from "@tanstack/react-router";
import {
  useTopAssets,
  useAssets,
  useRegime,
  useRotation,
  useNews,
  useSectors,
  useSentiment,
  useSnapshotMeta,
  useTechnicalQuality,
  useVolatility,
} from "@/hooks/queries";
import { MetricCard } from "@/components/iq/metric-card";
import { ConfidenceGauge } from "@/components/iq/confidence-gauge";
import { MiniChart } from "@/components/iq/mini-chart";
import { Change } from "@/components/iq/change";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { formatPrice } from "@/components/iq/market-card";
import { Heatmap } from "@/components/iq/heatmap";
import { AssetIcon } from "@/components/iq/asset-icon";
import { StatusBadge } from "@/components/iq/status-badge";
import { SkeletonCard } from "@/components/iq/skeletons";
import { ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
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
  const meta = useSnapshotMeta();
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
        {meta.data && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge tone={meta.data.source === "live" ? "bullish" : "warning"}>
              {meta.data.source === "live" ? "Live · Binance" : "Demo data"}
            </StatusBadge>
            <span className="num">
              {new Date(meta.data.updatedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}
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
  const assets = useAssets();

  const regimeAccent =
    regime.data?.regime === "Risk On"
      ? "bullish"
      : regime.data?.regime === "Risk Off"
        ? "bearish"
        : "warning";
  const winningLeader = assets.data?.find((a) => a.sector === rotation.data?.winning);
  const topAsset = assets.data?.[0];

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      {regime.data ? (
        <MetricCard
          label="Market Regime"
          accent={regimeAccent}
          value={regime.data.regime}
          footerLeft="Confidence"
          footerRight={
            <span
              className={cn(
                "num",
                regimeAccent === "bullish" && "text-bullish",
                regimeAccent === "bearish" && "text-bearish",
                regimeAccent === "warning" && "text-warning",
              )}
            >
              {regime.data.confidence}%
            </span>
          }
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
              {rotation.data.flow.slice(-3).map((n, i, arr) => (
                <span key={n} className="flex items-center gap-1">
                  <span className={cn("font-semibold", i === arr.length - 1 && "text-bullish")}>
                    {n}
                  </span>
                  {i < arr.length - 1 && (
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </span>
              ))}
            </div>
          }
          footerLeft="Rotation Strength"
          footerRight={
            <span
              className={rotation.data.strength === "High" ? "text-bullish" : "text-foreground"}
            >
              {rotation.data.strength}
            </span>
          }
        >
          {winningLeader && (
            <MiniChart
              data={winningLeader.spark}
              tone={winningLeader.change24h >= 0 ? "bullish" : "bearish"}
              height={28}
            />
          )}
        </MetricCard>
      ) : (
        <SkeletonCard />
      )}

      {sentiment.data ? (
        <MetricCard
          label="Sentiment"
          accent={
            sentiment.data.label === "Bullish"
              ? "bullish"
              : sentiment.data.label === "Bearish"
                ? "bearish"
                : "warning"
          }
          value={sentiment.data.label}
          footerLeft="Fear & Greed"
          footerRight={<span className="num text-foreground">{sentiment.data.score} / 100</span>}
        >
          <FearGreed value={sentiment.data.fearGreed} />
        </MetricCard>
      ) : (
        <SkeletonCard />
      )}

      {technical.data ? (
        <MetricCard
          label="Technical Quality"
          accent={
            technical.data.label === "Strong"
              ? "bullish"
              : technical.data.label === "Weak"
                ? "bearish"
                : "warning"
          }
          value={technical.data.label}
          footerLeft="Avg Signal Score"
          footerRight={<span className="num text-foreground">{technical.data.score} / 100</span>}
        >
          {topAsset && (
            <MiniChart
              data={topAsset.spark}
              tone={topAsset.change24h >= 0 ? "bullish" : "bearish"}
              height={28}
            />
          )}
        </MetricCard>
      ) : (
        <SkeletonCard />
      )}

      {volatility.data ? (
        <MetricCard
          label="Volatility"
          accent={
            volatility.data.label === "Low"
              ? "info"
              : volatility.data.label === "Medium"
                ? "warning"
                : "bearish"
          }
          value={volatility.data.label}
          footerLeft="BTC ATR (1D)"
          footerRight={
            <span className="num text-foreground">{volatility.data.vix.toFixed(1)}%</span>
          }
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

function MarketOverviewStrip() {
  const { data } = useAssets();

  const shown = data
    ? [...data].sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0)).slice(0, 7)
    : undefined;

  return (
    <IqCard>
      <div className="flex items-center justify-between">
        <CardEyebrow>Market Overview · Most Traded</CardEyebrow>
        <span className="text-xs text-muted-foreground">Last 48h · 1h bars</span>
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
                <MiniChart
                  data={a.spark}
                  tone={a.change24h >= 0 ? "bullish" : "bearish"}
                  height={32}
                />
              </div>
            ))
          : Array.from({ length: 7 }).map((_, i) => <SkeletonCard key={i} height={110} />)}
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
                className="group border-b border-border last:border-0 hover:bg-surface/60"
              >
                <td className="text-xs text-muted-foreground">
                  <Link
                    to="/token/$symbol"
                    params={{ symbol: a.ticker }}
                    className="block px-5 py-3"
                  >
                    {i + 1}
                  </Link>
                </td>
                <td>
                  <Link
                    to="/token/$symbol"
                    params={{ symbol: a.ticker }}
                    className="block px-2 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <AssetIcon ticker={a.ticker} className="h-6 w-6" />
                      <div className="leading-tight">
                        <div className="font-semibold group-hover:text-info">{a.ticker}</div>
                        <div className="text-[11px] text-muted-foreground">{a.name}</div>
                      </div>
                    </div>
                  </Link>
                </td>
                <td className="text-right num">
                  <Link
                    to="/token/$symbol"
                    params={{ symbol: a.ticker }}
                    className="block px-2 py-3"
                  >
                    {formatPrice(a.price)}
                  </Link>
                </td>
                <td className="text-right">
                  <Link
                    to="/token/$symbol"
                    params={{ symbol: a.ticker }}
                    className="block px-2 py-3"
                  >
                    <Change value={a.change24h} />
                  </Link>
                </td>
                <td className="text-right num font-semibold">
                  <Link
                    to="/token/$symbol"
                    params={{ symbol: a.ticker }}
                    className="block px-2 py-3"
                  >
                    {a.score}
                  </Link>
                </td>
                <td className="hidden sm:table-cell">
                  <Link
                    to="/token/$symbol"
                    params={{ symbol: a.ticker }}
                    className="block px-2 py-3"
                  >
                    <div className="ml-auto max-w-[120px]">
                      <MiniChart
                        data={a.spark}
                        tone={a.change24h >= 0 ? "bullish" : "bearish"}
                        height={26}
                      />
                    </div>
                  </Link>
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
          const impactTone =
            n.impact === "high" ? "bearish" : n.impact === "medium" ? "warning" : "info";
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
                  <span className="font-medium text-foreground">
                    {n.assets.slice(0, 4).join(", ")}
                  </span>
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
