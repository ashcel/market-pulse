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
import { MetricCard } from "@/components/features/metric-card";
import { ConfidenceGauge } from "@/components/features/confidence-gauge";
import { MiniChart } from "@/components/features/mini-chart";
import { Change } from "@/components/features/change";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { formatPrice } from "@/components/features/market-card";
import { Heatmap } from "@/components/features/heatmap";
import { MacroStrip } from "@/components/features/macro-strip";
import { MarketOpportunitiesCard } from "@/components/features/market-opportunities-card";
import { AssetIcon } from "@/components/features/asset-icon";
import { StatusBadge } from "@/components/features/status-badge";
import { SkeletonCard } from "@/components/features/skeletons";
import { Badge } from "@/components/ui/badge";

import { useActionableSetups } from "@/hooks/useActionableSetups";
import { useOpenTradesPnl } from "@/hooks/useOpenTradesPnl";
import { useReviewTrades } from "@/hooks/useReview";
import { useTokenEventsForSymbols } from "@/hooks/useTokenEvents";
import { useWatchlistStore } from "@/stores/watchlist";
import { ArrowRight, Newspaper, Radar, LineChart, Bot, Sparkles, Target } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { marketEdge, marketIntentOutlook } from "@/lib/engine/intent";
import { cn } from "@/lib/utils";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Market Pulse" },
      {
        name: "description",
        content:
          "Your morning market briefing: regime, capital rotation, top assets, news, and sector flow.",
      },
      { property: "og:title", content: "Dashboard — Market Pulse" },
      {
        property: "og:description",
        content: "Understand today's market regime and where capital is flowing.",
      },
    ],
  }),
  component: Dashboard,
});

const TOUR_SEEN_KEY = "iq-dashboard-tour-v2";

type DashboardTab = "opportunities" | "market" | "news";

/** Which tab a tour target lives in; targets outside the tabs map to null. */
const TAB_FOR_TOUR_TARGET: Record<string, DashboardTab | null> = {
  hero: null,
  tape: null,
  tabs: null,
  "engine-reads": "opportunities",
  opportunities: "opportunities",
  macro: "market",
  overview: "market",
  "top-assets": "market",
  heatmap: "market",
  news: "news",
};

const TOUR_STEPS: TourStep[] = [
  {
    target: "hero",
    title: "Today's vital signs",
    body: "Five cards summarising the whole market: regime, money rotation, crowd sentiment, signal quality, and Bitcoin volatility. Each card is a shortcut — click it to open the full page behind the number.",
  },
  {
    target: "tape",
    title: "Today's conditions",
    body: "One line describing today's tape conditions, with a read per style: scalps, intraday, swings, trend. Pick a token afterwards for its per-asset read.",
  },
  {
    target: "tabs",
    title: "Three views, no digging",
    body: "The rest of the dashboard is split by question: Opportunities (where is the action and what is tradable), Market (regime internals, leaders, sector flow), and News (what just happened). Switch tabs instead of scrolling.",
  },
  {
    target: "engine-reads",
    title: "Engine reads",
    body: "Tokens where the engine currently reads a long or short setup, ranked by signal strength. These are forward-test observations, not proven signals — the engine is still building its track record. When this is empty, the engine says wait: sitting out is a position too.",
  },
  {
    target: "opportunities",
    title: "Worth scanning",
    body: "A liquidity-gated scan of every Binance USDT pair — which tokens have real range, depth, and trade flow right now. It is a discovery list, not a signal: open a token for the engine's actual verdict.",
  },
  {
    target: "overview",
    title: "Most traded",
    body: "The highest-volume assets over the last 48 hours with price and a mini trend line, so you can see at a glance where the action is.",
  },
  {
    target: "top-assets",
    title: "Top assets",
    body: "The strongest assets by Market Pulse score — a 0–100 blend of trend, momentum, volume, and technical quality. Click any row for the full chart and trade plan.",
  },
  {
    target: "heatmap",
    title: "Capital flow heatmap",
    body: "Every tracked sector and its assets coloured by 24-hour performance — green means money flowing in, red means money flowing out. Click a cell to open that token.",
  },
  {
    target: "news",
    title: "News highlights",
    body: "Only the news that moves markets, tagged with expected impact and the assets it affects.",
  },
];

function Dashboard() {
  const greeting = getGreeting();
  const meta = useSnapshotMeta();
  const tour = useProductTour(TOUR_SEEN_KEY);
  const [tab, setTab] = useState<DashboardTab>("opportunities");

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
        <div className="flex items-center gap-3">
          {meta.data && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge tone={meta.data.source === "live" ? "bullish" : "warning"}>
                {meta.data.source === "live" ? "Live · Binance" : "Demo data"}
              </StatusBadge>
              <HeaderFreshness updatedAt={meta.data.updatedAt} />
              <HelpButton onClick={tour.start} />
            </div>
          )}
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as DashboardTab)}>
        <TabsList
          data-tour="tabs"
          className="grid h-auto w-full grid-cols-3 gap-1 rounded-xl border border-border bg-card p-1 sm:w-auto sm:max-w-md"
        >
          <TabsTrigger value="opportunities" className="gap-1.5 px-3 py-1.5 text-xs">
            <Radar className="h-3.5 w-3.5" aria-hidden />
            Opportunities
          </TabsTrigger>
          <TabsTrigger value="market" className="gap-1.5 px-3 py-1.5 text-xs">
            <LineChart className="h-3.5 w-3.5" aria-hidden />
            Market
          </TabsTrigger>
          <TabsTrigger value="news" className="gap-1.5 px-3 py-1.5 text-xs">
            <Newspaper className="h-3.5 w-3.5" aria-hidden />
            News
          </TabsTrigger>
        </TabsList>

        <TabsContent value="opportunities" className="mt-4 flex flex-col gap-5">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-4">
            <RegimeVerdictHero />
            <AiOverview />
          </div>

          <TradesAndBehaviorStrip />

          <HeroMetrics />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
            <div className="lg:col-span-2 h-full">
              <LiveSetupsStrip />
            </div>
            <div className="flex flex-col gap-4 lg:col-span-1 h-full">
              <EdgeStrip />
              <MacroStrip />
            </div>
          </div>

          <CatalystRail />

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <CardEyebrow>Market Opportunities · Worth Scanning</CardEyebrow>
              <span className="text-xs text-muted-foreground">
                Activity scan · not a trade signal
              </span>
            </div>
            <MarketOpportunitiesCard />
          </div>
        </TabsContent>

        <TabsContent value="market" className="mt-4 flex flex-col gap-5">
          <MarketOverviewStrip />
          <TopAssets />
          <CapitalFlowHeatmap />
        </TabsContent>

        <TabsContent value="news" className="mt-4">
          <NewsHighlights />
        </TabsContent>
      </Tabs>

      <ProductTour
        steps={TOUR_STEPS}
        open={tour.open && !!meta.data}
        onClose={tour.close}
        onStepChange={(target) => {
          const wanted = TAB_FOR_TOUR_TARGET[target];
          if (wanted) setTab(wanted);
        }}
      />
    </div>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 18) return "Good Afternoon";
  return "Good Evening";
}

/** "updated Ns ago" with a freshness dot: green < 60s, amber < 5m, red beyond. */
function HeaderFreshness({ updatedAt }: { updatedAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const updatedMs = new Date(updatedAt).getTime();
  const seconds = Math.max(0, Math.round((now - updatedMs) / 1000));

  const tone = seconds < 60 ? "bg-bullish" : seconds < 300 ? "bg-warning" : "bg-bearish";

  const label =
    seconds < 60
      ? `updated ${seconds}s ago`
      : seconds < 3600
        ? `updated ${Math.round(seconds / 60)}m ago`
        : `updated ${Math.round(seconds / 3600)}h ago`;

  return (
    <span className="flex items-center gap-1.5 num">
      <span className={cn("h-1.5 w-1.5 rounded-full", tone)} aria-hidden />
      {label}
    </span>
  );
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
    <div data-tour="hero" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      {regime.data ? (
        <MetricCard
          label="Market Regime"
          to="/regime"
          accent={regimeAccent}
          value={regime.data.regime}
          footerLeft={
            <span title="Rule-based blend of the five regime pillars below, not a calibrated probability.">
              Confidence
            </span>
          }
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
          to="/rotation"
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
          to="/news"
          accent={
            sentiment.data.label === "Bullish"
              ? "bullish"
              : sentiment.data.label === "Bearish"
                ? "bearish"
                : "warning"
          }
          value={sentiment.data.label}
          footerLeft={
            sentiment.data.source === "proxy" ? (
              <span title="The Fear & Greed API was unreachable — this is an internal breadth/momentum estimate, not the real index.">
                Fear & Greed (est.)
              </span>
            ) : (
              "Fear & Greed"
            )
          }
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
          to="/technical"
          accent={
            technical.data.label === "Strong"
              ? "bullish"
              : technical.data.label === "Weak"
                ? "bearish"
                : "warning"
          }
          value={technical.data.label}
          footerLeft={
            <span title="Rule-based checklist score, not a calibrated win probability — pending the engine's 1.0.0 forward-test verdict. Averaged across the tracked universe.">
              Avg Signal Score
            </span>
          }
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
          to="/regime"
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
    <IqCard padded={false} data-tour="tape" className="flex flex-col p-5 h-full">
      <div className="mb-4">
        <CardEyebrow>Today's Edge</CardEyebrow>
        <div className="text-xs text-muted-foreground mt-1 truncate">{edge.detail}</div>
      </div>
      <div className="flex flex-col gap-2.5 flex-1 justify-center">
        {entries.map((entry) => (
          <div
            key={entry.intent}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-surface/30 p-3"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-6 h-6 rounded bg-muted/50 flex items-center justify-center shrink-0">
                {entry.intent === "scalp" && (
                  <span className="text-info text-sm font-bold">⚡</span>
                )}
                {entry.intent === "intraday" && (
                  <span className="text-info text-sm font-bold">⏱</span>
                )}
                {entry.intent === "swing" && (
                  <span className="text-warning text-sm font-bold">📈</span>
                )}
                {entry.intent === "position" && (
                  <span className="text-bearish text-sm font-bold">📉</span>
                )}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold capitalize text-foreground">
                  {entry.label}
                </span>
                <span className="text-[10px] text-muted-foreground truncate">{entry.note}</span>
              </div>
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

// Engine reads: current long/short reads from the engine, clearly labeled as
// forward-test-only — the engine is a context instrument pending its 1.0.0
// verdict, so nothing here may imply proven edge (EDR 0017).
function TopSetups() {
  const { data } = useAssets();
  if (!data) return null;

  const setups = data
    .filter((a) => a.decision === "buy-candidate" || a.decision === "short-candidate")
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 4);

  return (
    <IqCard data-tour="engine-reads">
      <div className="flex items-center justify-between">
        <CardEyebrow>Engine Reads</CardEyebrow>
        <span className="text-xs text-muted-foreground">Forward test in progress · 1H bars</span>
      </div>
      {setups.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No engine reads right now — the engine says{" "}
          <span className="font-semibold text-foreground">wait</span>. Sitting out is a position;
          check back after the next refresh.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {setups.map((a) => {
            const long = a.decision === "buy-candidate";
            return (
              <Link
                key={a.id}
                to="/token/$symbol"
                params={{ symbol: a.ticker }}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
                  long
                    ? "border-bullish/30 bg-bullish-soft hover:border-bullish/60"
                    : "border-bearish/30 bg-bearish-soft hover:border-bearish/60",
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AssetIcon ticker={a.ticker} className="h-5 w-5" />
                    <span className="text-sm font-semibold">{a.ticker}</span>
                  </div>
                  <span
                    className={cn(
                      "text-[10px] font-bold uppercase tracking-wider",
                      long ? "text-bullish" : "text-bearish",
                    )}
                  >
                    {long ? "Long" : "Short"}
                  </span>
                </div>
                <div className="text-xs capitalize text-muted-foreground">
                  {a.setupType?.replaceAll("-", " ")}
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="num">{formatPrice(a.price)}</span>
                  <span
                    className="num font-semibold"
                    title="Heuristic checklist score, not a proven-edge probability."
                  >
                    {a.confidence}/100
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </IqCard>
  );
}

function MarketOverviewStrip() {
  const { data } = useAssets();

  const shown = data
    ? [...data].sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0)).slice(0, 7)
    : undefined;

  return (
    <IqCard data-tour="overview">
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
    <IqCard padded={false} data-tour="top-assets">
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
                title="Heuristic checklist score, not a proven-edge probability. Independently weighted from Signal and Technical — not confirmation of the same read."
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
    <IqCard padded={false} data-tour="news" className="flex flex-col">
      <div className="flex items-center justify-between p-5 pb-3">
        <CardEyebrow>News Highlights</CardEyebrow>
        <Link to="/news" className="text-xs font-medium text-info hover:underline">
          View All
        </Link>
      </div>
      <ul className="flex flex-1 flex-col divide-y divide-border">
        {data?.slice(0, 8).map((n) => {
          const impactTone =
            n.impact === "high" ? "bearish" : n.impact === "medium" ? "warning" : "info";
          return (
            <li key={n.id}>
              <Link
                to="/news"
                className="flex gap-3 px-5 py-3 transition-colors hover:bg-surface/60"
              >
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
              </Link>
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
    <div data-tour="heatmap" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <CardEyebrow>Capital Flow Heatmap</CardEyebrow>
        <span className="text-xs text-muted-foreground">1D</span>
      </div>
      {data ? <Heatmap sectors={data} /> : <SkeletonCard height={240} />}
    </div>
  );
}

function AiOverview() {
  return (
    <IqCard
      className="border-border bg-card relative overflow-hidden flex flex-col h-full"
      padded={false}
    >
      <div className="p-5 sm:p-6 flex flex-col h-full">
        <div className="flex items-center gap-2 mb-4">
          <CardEyebrow className="flex items-center gap-1.5">
            <Bot className="w-4 h-4" /> AI Overview
          </CardEyebrow>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
            Beta
          </span>
        </div>
        <ul className="flex flex-col gap-2.5 mb-6 flex-1">
          <li className="flex items-start gap-2 text-sm">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-bullish/70" />
            <span className="text-muted-foreground">
              Trend remains supported across higher timeframes.
            </span>
          </li>
          <li className="flex items-start gap-2 text-sm">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-bullish/70" />
            <span className="text-muted-foreground">
              Market breadth improved, rotation flowing into majors.
            </span>
          </li>
          <li className="flex items-start gap-2 text-sm">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-bullish/70" />
            <span className="text-muted-foreground">
              Volatility is low and stable — supportive for trend continuation.
            </span>
          </li>
          <li className="flex items-start gap-2 text-sm">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-bullish/70" />
            <span className="text-muted-foreground">
              No major macro or event risks on the radar today.
            </span>
          </li>
        </ul>
        <div className="mt-auto flex items-center justify-between">
          <div className="text-xs font-medium">
            <span className="text-bullish">Recommendation: </span>
            <span className="text-foreground">Trade your plan • Normal size • Focus on trend</span>
          </div>
          <button className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface/80">
            <Sparkles className="h-3.5 w-3.5" />
            Ask AI
          </button>
        </div>
      </div>
    </IqCard>
  );
}

function RegimeVerdictHero() {
  const regime = useRegime();
  if (!regime.data) return <SkeletonCard className="h-full min-h-[240px]" />;

  const r = regime.data;
  let actionLine = "";
  let toneClass = "";
  let iconClass = "";

  if (r.regime === "Risk On") {
    actionLine = "Conditions favorable — trade your plan, normal size.";
    toneClass = "border-bullish/50 bg-bullish-soft";
    iconClass = "text-bullish";
  } else if (r.regime === "Neutral") {
    actionLine = "Mixed — be selective, reduce size, skip low-conviction setups.";
    toneClass = "border-warning/50 bg-warning-soft";
    iconClass = "text-warning";
  } else {
    actionLine = "Poor conditions — sit out or scalp only, tight risk.";
    toneClass = "border-bearish/50 bg-bearish-soft";
    iconClass = "text-bearish";
  }

  const trendPillar = r.pillars.find((p) => p.label === "Trend");
  const breadthPillar = r.pillars.find((p) => p.label === "Breadth");
  const descSentence = `${trendPillar ? `BTC daily structure ${trendPillar.displayValue?.toLowerCase()}` : ""}${breadthPillar ? `; breadth ${breadthPillar.score}%` : ""}.`;

  return (
    <IqCard
      className={cn("border bg-card relative overflow-hidden flex flex-col h-full", toneClass)}
      padded={false}
    >
      <div className="p-5 sm:p-6 flex flex-col h-full justify-between">
        <div>
          <CardEyebrow className="mb-4">Market Outlook</CardEyebrow>
          <div className="flex justify-between items-start">
            <div>
              <h2
                className={cn(
                  "text-3xl sm:text-4xl font-black tracking-tight uppercase",
                  iconClass,
                )}
              >
                {r.regime}
              </h2>
              <p className="mt-3 text-sm font-medium text-foreground">{actionLine}</p>
              <p className="mt-1 text-sm text-muted-foreground">{descSentence}</p>
            </div>
            {r.regime === "Risk On" && (
              <div className="mr-4 mt-2 opacity-90">
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={iconClass}
                >
                  <path d="M4 14l3-3m0 0l3 3m-3-3v6m8-6h-6m6 0l2-2m0 0l2 2m-2-2v6" />
                  <path d="M3 9c0-3 3-4 5-4h8c2 0 5 1 5 4v6h-21v-6z" />
                  <path d="M6 5l-2-2" />
                  <path d="M18 5l2-2" />
                </svg>
              </div>
            )}
          </div>
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          {r.pillars.slice(0, 3).map((p) => (
            <Badge
              key={p.label}
              variant="outline"
              className={cn(
                "text-xs bg-background/40 border-current/20 px-3 py-1 font-medium",
                iconClass,
              )}
            >
              <span className="text-muted-foreground mr-1">{p.label}:</span>{" "}
              {p.displayValue || `${p.score}%`}
            </Badge>
          ))}
        </div>
      </div>
    </IqCard>
  );
}

function LiveSetupsStrip() {
  const { data, isLoading } = useActionableSetups();

  return (
    <IqCard padded={false} className="p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <CardEyebrow>Live Setups</CardEyebrow>
        <Link to="/markets" className="text-[10px] text-muted-foreground hover:text-foreground">
          View all →
        </Link>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3 flex-1">
          <SkeletonCard className="h-24 w-full" />
          <SkeletonCard className="h-24 w-full" />
          <SkeletonCard className="h-24 w-full" />
        </div>
      ) : !data || data.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border/50 bg-surface/30 p-6 text-center">
          <Target className="h-8 w-8 text-muted-foreground/50 mb-3" />
          <p className="text-sm font-medium text-foreground">No live setups right now.</p>
          <p className="text-xs text-muted-foreground mt-1">That's a fine answer — wait for one.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {data.slice(0, 3).map((setup) => {
            const long = setup.assessment.direction === "long";
            return (
              <Link
                key={setup.ticker}
                to="/token/$symbol"
                params={{ symbol: setup.ticker }}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
                  long
                    ? "border-bullish/30 bg-bullish-soft hover:border-bullish/60"
                    : "border-bearish/30 bg-bearish-soft hover:border-bearish/60",
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AssetIcon ticker={setup.ticker} className="h-5 w-5" />
                    <span className="text-sm font-semibold">
                      {setup.ticker}{" "}
                      <span className="text-muted-foreground font-normal">
                        · {setup.assessment.intent}
                      </span>
                    </span>
                  </div>
                  <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-foreground">
                    <span
                      className={cn("h-2 w-2 rounded-full", long ? "bg-bullish" : "bg-bearish")}
                    />
                    {setup.assessment.verdict}
                  </span>
                </div>
                <div className="text-xs font-medium text-foreground/80 leading-snug line-clamp-2">
                  {setup.assessment.triggers[0]}
                </div>
                {setup.assessment.plan && (
                  <div className="mt-1 flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">
                      Target: {formatPrice(setup.assessment.plan.target1)}
                    </span>
                    <span className="font-semibold text-foreground">
                      R:R {setup.assessment.plan.rewardRisk1.toFixed(1)}
                    </span>
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </IqCard>
  );
}

/** 1st/2nd/3rd/4th/... — handles the 11th/12th/13th exception. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function TradesAndBehaviorStrip() {
  const { rows, count, totalUnrealized } = useOpenTradesPnl();
  const { trades } = useReviewTrades();

  let behaviorWarning = null;
  if (trades && trades.length > 0) {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const recent = trades.filter((t) => new Date(t.opened_at).getTime() > twoHoursAgo);
    if (recent.length >= 3) {
      behaviorWarning = `⚠ ${ordinal(recent.length)} trade in 2h — overtrade watch`;
    }
  }

  if (count === 0 && !behaviorWarning) return null;

  return (
    <IqCard padded={false} className="px-5 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-x-6 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <CardEyebrow>Your Trades</CardEyebrow>
          {count > 0 && (
            <span className="text-sm font-semibold">
              {count} open <span className="text-muted-foreground font-normal mx-1">·</span>
              <span className={totalUnrealized >= 0 ? "text-bullish" : "text-bearish"}>
                {totalUnrealized >= 0 ? "+" : ""}
                {totalUnrealized}
              </span>{" "}
              unrealized
            </span>
          )}
        </div>
        {behaviorWarning && (
          <div className="flex items-center gap-2 text-sm font-medium text-warning bg-warning/10 px-3 py-1 rounded-md">
            {behaviorWarning}
          </div>
        )}
      </div>
    </IqCard>
  );
}

function CatalystRail() {
  const watchedTickers = useWatchlistStore((s) => s.tickers);
  const { data: events } = useTokenEventsForSymbols(watchedTickers);

  if (!events || events.length === 0) return null;

  const now = Date.now();
  const futureEvents = events
    .filter((e) => {
      if (!e.publishedAt) return false;
      const time = new Date(e.publishedAt).getTime();
      return time > now && time < now + 72 * 60 * 60 * 1000;
    })
    .sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());

  if (futureEvents.length === 0) return null;

  return (
    <IqCard padded={false} className="px-5 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-x-6 gap-y-3">
        <CardEyebrow className="shrink-0">What's Coming</CardEyebrow>
        <div className="flex flex-col sm:flex-row flex-wrap gap-x-4 gap-y-2">
          {futureEvents.slice(0, 3).map((e) => {
            const timeUntil = Math.round(
              (new Date(e.publishedAt).getTime() - now) / (60 * 60 * 1000),
            );
            return (
              <Link
                key={e.id}
                to="/token/$symbol"
                params={{ symbol: e.symbol }}
                className="flex items-center gap-2 text-sm transition-colors hover:text-info"
              >
                <span className="text-warning">⚠</span>
                <span className="font-semibold">{e.symbol}</span>
                <span className="text-muted-foreground truncate max-w-[200px]">{e.title}</span>
                <span className="text-xs text-muted-foreground border border-border rounded px-1">
                  {timeUntil}h
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </IqCard>
  );
}
