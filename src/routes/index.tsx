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
import { MacroStrip } from "@/components/iq/macro-strip";
import { MarketOpportunitiesCard } from "@/components/iq/market-opportunities-card";
import { AssetIcon } from "@/components/iq/asset-icon";
import { StatusBadge } from "@/components/iq/status-badge";
import { SkeletonCard } from "@/components/iq/skeletons";
import { ArrowRight, Newspaper, Radar, LineChart } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { marketEdge, marketIntentOutlook } from "@/lib/engine/intent";
import { cn } from "@/lib/utils";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/iq/product-tour";

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
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
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
              <span className="num">
                {new Date(meta.data.updatedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          )}
          <HelpButton onClick={tour.start} />
        </div>
      </header>

      <HeroMetrics />
      <EdgeStrip />

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
          <TopSetups />
          <MarketOpportunitiesCard />
        </TabsContent>

        <TabsContent value="market" className="mt-4 flex flex-col gap-5">
          <div data-tour="macro">
            <MacroStrip />
          </div>
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
          to="/technical"
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

// What are today's tape conditions per trading objective? One compact strip —
// derived from regime + volatility — describing what kind of tape this is
// before picking a token; the token page then answers per asset. Each
// style chip carries its one-line rationale as a tooltip.
function EdgeStrip() {
  const regime = useRegime();
  const volatility = useVolatility();
  if (!regime.data || !volatility.data) return null;

  const entries = marketIntentOutlook(
    regime.data.regime,
    regime.data.trendStrength,
    volatility.data.label,
  );
  const edge = marketEdge(regime.data.regime, regime.data.trendStrength, volatility.data.label);

  return (
    <IqCard padded={false} data-tour="tape" className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <CardEyebrow>Tape Overview</CardEyebrow>
          <span className="text-sm font-semibold capitalize">{edge.label}</span>
        </div>
        <p
          className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground lg:block"
          title={edge.detail}
        >
          {edge.detail}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {entries.map((entry) => (
            <span
              key={entry.intent}
              title={entry.note}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1"
            >
              <span className="text-[11px] font-medium">{entry.label}</span>
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
            </span>
          ))}
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground lg:hidden">
        {edge.detail}
      </p>
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
                  <span className="num font-semibold">{a.confidence}/100</span>
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
