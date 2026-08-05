import { createFileRoute, Link } from "@tanstack/react-router";
import { LineChart, Radar } from "lucide-react";
import { useState } from "react";

import { AttentionFeed } from "@/components/features/attention-feed";
import { AssetIcon } from "@/components/features/asset-icon";
import { Change } from "@/components/features/change";
import { GlobalMetricsRow } from "@/components/features/global-metrics-row";
import { Heatmap } from "@/components/features/heatmap";
import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { LatestNewsRail } from "@/components/features/latest-news-rail";
import { MacroStrip } from "@/components/features/macro-strip";
import { formatPrice } from "@/components/features/market-card";
import { MarketContextStrip } from "@/components/features/market-context-strip";
import { MarketOutlookHero } from "@/components/features/market-outlook-hero";
import { MiniChart } from "@/components/features/mini-chart";
import { SkeletonCard } from "@/components/features/skeletons";
import { StatusBadge } from "@/components/features/status-badge";
import { UpcomingEventsRail } from "@/components/features/upcoming-events-rail";
import { WatchlistRail } from "@/components/features/watchlist-rail";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";
import {
  useAssets,
  useRegime,
  useSectors,
  useSnapshotMeta,
  useTopAssets,
  useVolatility,
} from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";
import { useOpenTradesPnl } from "@/hooks/useOpenTradesPnl";
import { useReviewTrades } from "@/hooks/useReview";
import { marketEdge, marketIntentOutlook } from "@/lib/engine/intent";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Market Pulse" },
      {
        name: "description",
        content:
          "Your market briefing: today's regime verdict, the events and setups asking for attention, and the context behind them.",
      },
      { property: "og:title", content: "Dashboard — Market Pulse" },
      {
        property: "og:description",
        content: "Understand today's market regime and what is worth your attention.",
      },
    ],
  }),
  component: Dashboard,
});

const TOUR_SEEN_KEY = "iq-dashboard-tour-v3";

const TOUR_STEPS: TourStep[] = [
  {
    target: "outlook",
    title: "Today's verdict",
    body: "The regime call and what it means for your sizing, beside a rule-based brief restating the snapshot in sentences. It answers 'should I trade today?' before you scroll.",
  },
  {
    target: "globals",
    title: "Global conditions",
    body: "Total market cap and BTC dominance from the breadth ingest, Binance USDT turnover, the Fear & Greed index, and the share of liquid alts beating BTC over 24h.",
  },
  {
    target: "attention",
    title: "What's asking for attention",
    body: "One ranked feed across engine setups, volatility spikes, the liquidity scan, market-moving news, and token unlocks. Filter by type. Setups are the only cards with a direction — the rest is context.",
  },
  {
    target: "context",
    title: "Market context",
    body: "Regime, rotation, sentiment, breadth, and volatility at a glance. Tap any tile for the full page behind the number.",
  },
  {
    target: "rail",
    title: "Calendar, news, watchlist",
    body: "What is coming (macro prints and dated token events), the latest headlines, and your watchlist — which is also what scopes your event alerts.",
  },
];

function Dashboard() {
  const meta = useSnapshotMeta();
  const tour = useProductTour(TOUR_SEEN_KEY);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {getGreeting()}, Dewi <span aria-hidden>👋</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Here's your market briefing for today.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {meta.data && (
            <>
              <StatusBadge tone={meta.data.source === "live" ? "bullish" : "warning"}>
                {meta.data.source === "live" ? "Live · Binance" : "Demo data"}
              </StatusBadge>
              <span className="num">
                {new Date(meta.data.updatedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </>
          )}
          <HelpButton onClick={tour.start} />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div data-tour="outlook">
            <MarketOutlookHero />
          </div>

          <div data-tour="globals">
            <GlobalMetricsRow />
          </div>

          <AttentionFeed />

          <TradesAndBehaviorStrip />

          <div data-tour="context" className="flex flex-col gap-3">
            <CardEyebrow>Market Context</CardEyebrow>
            <MarketContextStrip />
          </div>

          <BelowTheFold />
        </div>

        <aside data-tour="rail" className="flex flex-col gap-5">
          <UpcomingEventsRail />
          <LatestNewsRail />
          <WatchlistRail />
        </aside>
      </div>

      <ProductTour steps={TOUR_STEPS} open={tour.open && !!meta.data} onClose={tour.close} />
    </div>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 18) return "Good Afternoon";
  return "Good Evening";
}

/**
 * The deeper snapshot planes, kept one tab away rather than deleted: the
 * per-style edge read and the market internals. Discovery scans live on
 * `/discover`, headlines on `/news`.
 */
function BelowTheFold() {
  const [tab, setTab] = useState<"edge" | "market">("edge");

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "edge" | "market")}>
      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-xl border border-border bg-card p-1 sm:w-auto sm:max-w-xs">
        <TabsTrigger value="edge" className="gap-1.5 px-3 py-1.5 text-xs">
          <Radar className="h-3.5 w-3.5" aria-hidden />
          Today's Edge
        </TabsTrigger>
        <TabsTrigger value="market" className="gap-1.5 px-3 py-1.5 text-xs">
          <LineChart className="h-3.5 w-3.5" aria-hidden />
          Market Internals
        </TabsTrigger>
      </TabsList>

      <TabsContent value="edge" className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <EdgeStrip />
        <MacroStrip />
      </TabsContent>

      <TabsContent value="market" className="mt-4 flex flex-col gap-5">
        <MarketOverviewStrip />
        <TopAssets />
        <CapitalFlowHeatmap />
      </TabsContent>
    </Tabs>
  );
}

function EdgeStrip() {
  const regime = useRegime();
  const volatility = useVolatility();
  if (!regime.data || !volatility.data) return <SkeletonCard className="h-full min-h-[160px]" />;

  const entries = marketIntentOutlook(
    regime.data.regime,
    regime.data.trendStrength,
    volatility.data.label,
  );
  const edge = marketEdge(regime.data.regime, regime.data.trendStrength, volatility.data.label);

  return (
    <IqCard padded={false} className="flex h-full flex-col p-5">
      <div className="mb-4">
        <CardEyebrow>Today's Edge</CardEyebrow>
        <div className="mt-1 text-xs text-muted-foreground">{edge.detail}</div>
      </div>
      <div className="flex flex-1 flex-col justify-center gap-2.5">
        {entries.map((entry) => (
          <div
            key={entry.intent}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-surface/30 p-3"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-semibold capitalize text-foreground">
                {entry.label}
              </span>
              <span className="truncate text-[10px] text-muted-foreground">{entry.note}</span>
            </div>
            <StatusBadge
              tone={
                entry.stance === "favored"
                  ? "bullish"
                  : entry.stance === "selective"
                    ? "warning"
                    : "bearish"
              }
            >
              {entry.stance}
            </StatusBadge>
          </div>
        ))}
      </div>
    </IqCard>
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
              <Link
                key={a.id}
                to="/token/$symbol"
                params={{ symbol: a.ticker }}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-info/50"
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
              </Link>
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
              <th
                className="px-2 py-2 text-right font-semibold"
                title="Heuristic checklist score, not a proven-edge probability."
              >
                Score
              </th>
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
                <td className="num text-right">
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
                <td className="num text-right font-semibold">
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

/**
 * Open exposure plus a behaviour flag when a pattern is actually live. When
 * there is neither, this renders nothing — the dashboard does not nag.
 */
function TradesAndBehaviorStrip() {
  const { isAuthed } = useAuth();
  const { count, totalUnrealized } = useOpenTradesPnl();
  const { trades } = useReviewTrades();

  let behaviorWarning: string | null = null;
  if (trades && trades.length > 0) {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const recent = trades.filter((t) => new Date(t.opened_at).getTime() > twoHoursAgo);
    if (recent.length >= 3) {
      behaviorWarning = `${recent.length} trades in the last 2h — overtrade watch`;
    }
  }

  if (!isAuthed || (count === 0 && !behaviorWarning)) return null;

  return (
    <IqCard padded={false} className="px-5 py-4">
      <div className="flex flex-col gap-x-6 gap-y-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <CardEyebrow>Your Trades</CardEyebrow>
          {count > 0 && (
            <span className="text-sm font-semibold">
              {count} open <span className="mx-1 font-normal text-muted-foreground">·</span>
              <span className={totalUnrealized >= 0 ? "text-bullish" : "text-bearish"}>
                {totalUnrealized >= 0 ? "+" : ""}
                {totalUnrealized}
              </span>{" "}
              unrealized
            </span>
          )}
          <Link to="/trades" className="text-xs font-medium text-info hover:underline">
            Open trades
          </Link>
        </div>
        {behaviorWarning && (
          <div
            className={cn(
              "flex items-center gap-2 rounded-md bg-warning/10 px-3 py-1 text-sm font-medium text-warning",
            )}
          >
            ⚠ {behaviorWarning}
          </div>
        )}
      </div>
    </IqCard>
  );
}
