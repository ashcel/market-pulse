import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Target, Newspaper, Activity, Gauge, ArrowDown, ArrowUp, Loader2, Search } from "lucide-react";

import {
  useCatalystRailEvents,
  useRegime,
  useSentiment,
  useVolatility,
  useNews,
  useSnapshotMeta,
  useUniverse,
  type ImpactDirection,
  type ImpactLevel,
  type UniverseSnapshot,
} from "@/hooks/queries";
import { fearGreedLabel } from "@/lib/engine/external-context";
import { useActionableSetups } from "@/hooks/useActionableSetups";
import { useDerivativesSummary } from "@/hooks/useDerivatives";
import { useLivePositions, type LivePosition } from "@/hooks/useLivePositions";
import type { OpenTradePnl } from "@/hooks/useOpenTradesPnl";
import { useReviewTrades } from "@/hooks/useReview";
import { useWatchlistStore } from "@/stores/watchlist";

import { AssetIcon } from "@/components/features/asset-icon";
import { formatPrice } from "@/components/features/market-card";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { StatusBadge } from "@/components/features/status-badge";
import { SkeletonCard } from "@/components/features/skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";
import { cn } from "@/lib/utils";
import { AlternativesStrip } from "@/components/features/alternatives-strip";
import { SearchCommand } from "@/components/features/search-command";
import { AiSentimentStrip } from "@/components/features/ai-sentiment-strip";
import { SkipCheckPanel } from "@/components/features/skip-check-panel";
import { useTrustState } from "@/hooks/useTrustState";
import { useAiDeskStore } from "@/stores/ai-desk";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Today — Market Pulse" },
      {
        name: "description",
        content:
          "Should I trade right now? Regime verdict, open risk, live setups, and catalysts — one screen.",
      },
      { property: "og:title", content: "Today — Market Pulse" },
      {
        property: "og:description",
        content: "Understand today's market regime and whether it's worth trading.",
      },
    ],
  }),
  component: Dashboard,
});

const TOUR_SEEN_KEY = "iq-dashboard-tour-v3";

const TOUR_STEPS: TourStep[] = [
  {
    target: "regime-hero",
    title: "Today's call, in words",
    body: "The regime verdict — should you trade right now — with the one-sentence why. This is the whole point of Today; everything else is evidence.",
  },
  {
    target: "trades-behavior",
    title: "Open risk & behavior",
    body: "Your open positions' unrealized PnL, plus a flag if your recent trading looks like overtrading. Appears only when there's something to say.",
  },
  {
    target: "live-setups",
    title: "Live setups",
    body: "Up to three verdict-live tokens right now, each with its objective and what would flip the call. Empty is a valid answer — it means sit out.",
  },
  {
    target: "market-context",
    title: "Market context at a glance",
    body: "Sentiment, volatility, trend and breadth in one strip — the conditions behind today's call. Tap through to Markets for the full picture.",
  },
  {
    target: "catalyst-rail",
    title: "What's coming",
    body: "Scheduled events on the tokens you watch, ranked by how soon they land. Click one to open that token's verdict.",
  },
  {
    target: "top-news",
    title: "News that moves markets",
    body: "The highest-impact headlines right now, with direction and affected assets. Open a token to check a trade against them.",
  },
];

function Dashboard() {
  const greeting = getGreeting();
  const meta = useSnapshotMeta();
  const tour = useProductTour(TOUR_SEEN_KEY);
  const universe = useUniverse();
  const { data: setups } = useActionableSetups(universe.data);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-3 sm:gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {greeting}, Dewi <span aria-hidden>👋</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Should you trade right now? Here's today's answer.
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
          {/* Primary search entry point on mobile / Telegram Mini App, where
              the desktop TopBar (and its search box) never renders. */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
            aria-label="Cari token"
            title="Cari token"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      </header>

      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />

      <RegimeVerdictHero />
      <MarketContextStrip />
      <DerivativesPulseStrip />
      <AiSentimentStrip />
      <LivePositionsStrip />
      <LiveSetupsStrip universe={universe.data} isLoading={universe.isLoading} />
      {(!setups || setups.length === 0) && <AlternativesStrip />}
      <CatalystRail />
      <TopNews />

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
      data-tour="regime-hero"
      className={cn("border bg-card relative overflow-hidden flex flex-col", toneClass)}
      padded={false}
    >
      <div className="flex flex-col justify-between p-3 sm:p-6">
        <div>
          <CardEyebrow className="mb-3 sm:mb-4">Market Outlook</CardEyebrow>
          <div className="flex justify-between items-start">
            <div>
              <h2
                className={cn(
                  "text-2xl font-black uppercase tracking-tight sm:text-4xl",
                  iconClass,
                )}
              >
                {r.regime}
              </h2>
              <p className="mt-2 text-sm font-medium text-foreground sm:mt-3">{actionLine}</p>
              <p className="mt-1 text-sm text-muted-foreground">{descSentence}</p>
            </div>
            {r.regime === "Risk On" && (
              <div className="ml-2 hidden opacity-90 sm:mr-4 sm:mt-2 sm:block">
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
        <div className="mt-4 flex flex-wrap gap-2 sm:mt-8 sm:gap-3">
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

function positionToTradeRow(position: LivePosition): OpenTradePnl {
  const quantity = Math.abs(position.positionAmt);
  const margin = (position.entryPrice * quantity) / Math.max(position.leverage, 1);
  const unrealizedPct = margin > 0 ? (position.unrealizedPnl / margin) * 100 : 0;
  const now = new Date().toISOString();
  return {
    trade: {
      id: `binance:${position.symbol}:${position.side}`,
      user_id: "",
      symbol: position.symbol,
      direction: position.side === "LONG" ? "long" : "short",
      entry_price: position.entryPrice,
      exit_price: null,
      quantity,
      leverage: position.leverage,
      pnl: null,
      pnl_percent: null,
      status: "open",
      strategy: null,
      notes: null,
      opened_at: null,
      closed_at: null,
      created_at: now,
      updated_at: null,
    },
    livePrice: position.markPrice,
    unrealizedPnl: position.unrealizedPnl,
    unrealizedPct,
  };
}

function LivePositionsStrip() {
  const { positions } = useLivePositions();
  const { trades } = useReviewTrades();
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const setAiDeskOpen = useAiDeskStore((state) => state.setOpen);
  const addAiDeskMessage = useAiDeskStore((state) => state.addAssistantMessage);
  const rows = positions.map(positionToTradeRow);
  const count = rows.length;
  const totalUnrealized = rows.reduce((sum, row) => sum + (row.unrealizedPnl ?? 0), 0);

  const analyzeTrades = async () => {
    setAiDeskOpen(true);
    setAnalysisLoading(true);
    try {
      const response = await fetch("/api/ai-desk/analyze-trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: positions.map(({ symbol, side, entryPrice, markPrice, unrealizedPnl, leverage }) => ({
            symbol,
            side,
            entryPrice,
            markPrice,
            unrealizedPnl,
            leverage,
          })),
        }),
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || body?.detail || `HTTP ${response.status}`);
      }
      const body = (await response.json()) as { data: { response: string } };
      addAiDeskMessage(body.data.response, "AI Desk · Active Trades", positions);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed";
      addAiDeskMessage(`Unable to analyze active trades: ${message}`, "system");
    } finally {
      setAnalysisLoading(false);
    }
  };

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
    <IqCard data-tour="trades-behavior" padded={false} className="p-3 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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

      {count > 0 && (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {rows.map((row) => {
              const pnl = row.unrealizedPnl ?? 0;
              const positive = pnl > 0;
              const negative = pnl < 0;
              const long = row.trade.direction === "long";

              return (
                <div
                  key={row.trade.id}
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg border border-border/70 border-l-2 bg-surface/30 px-3 py-2.5",
                    positive && "border-l-bullish",
                    negative && "border-l-bearish",
                    !positive && !negative && "border-l-muted-foreground/50",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {long ? (
                      <ArrowUp className="h-4 w-4 shrink-0 text-bullish" aria-label="Long" />
                    ) : (
                      <ArrowDown className="h-4 w-4 shrink-0 text-bearish" aria-label="Short" />
                    )}
                    <span className="truncate text-sm font-semibold">{row.trade.symbol}</span>
                    <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
                      {row.trade.leverage}x
                    </Badge>
                  </div>
                  <div className="text-right text-[11px] leading-tight text-muted-foreground">
                    <div>Entry {formatPrice(row.trade.entry_price)}</div>
                    <div>Mark {row.livePrice === null ? "—" : formatPrice(row.livePrice)}</div>
                  </div>
                  <div
                    className={cn(
                      "min-w-20 text-right num",
                      positive && "text-bullish",
                      negative && "text-bearish",
                      !positive && !negative && "text-muted-foreground",
                    )}
                  >
                    <div className="text-sm font-bold">
                      {pnl >= 0 ? "+" : ""}
                      {pnl.toFixed(2)}
                    </div>
                    <div className="text-[11px] font-medium">
                      {row.unrealizedPct === null
                        ? "no mark price"
                        : `${row.unrealizedPct >= 0 ? "+" : ""}${row.unrealizedPct.toFixed(2)}%`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex flex-col items-stretch gap-3 sm:items-end">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={analysisLoading}
              onClick={analyzeTrades}
            >
              {analysisLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              {analysisLoading ? "Reviewing trades..." : "Ask AI about your trades"}
            </Button>
            <Link
              to="/journal"
              search={{ tab: "open" }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              View all trades →
            </Link>
          </div>
        </>
      )}
    </IqCard>
  );
}

/** Verdict-live setups only, hard-capped at 3 (already capped in useActionableSetups). */
function LiveSetupsStrip({ universe, isLoading }: { universe: UniverseSnapshot | undefined; isLoading: boolean }) {
  const { data } = useActionableSetups(universe);
  const trust = useTrustState();
  const decisionsAvailable = trust.details.market.status === "healthy" && trust.details.account.status !== "unavailable";

  return (
    <IqCard data-tour="live-setups" padded={false} className="flex flex-col p-3 sm:p-5">
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
            const long = setup.verdict.direction === "long";
            return (
              <div
                key={setup.ticker}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border border-x-transparent p-2.5 transition-colors sm:border-x sm:p-3",
                  long
                    ? "border-bullish/30 bg-bullish-soft"
                    : "border-bearish/30 bg-bearish-soft",
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AssetIcon ticker={setup.ticker} className="h-5 w-5" />
                    <Link to="/token/$symbol" params={{ symbol: setup.ticker }} className="text-sm font-semibold hover:text-info">
                      {setup.ticker}{" "}
                      <span className="text-muted-foreground font-normal">
                         · {setup.verdict.objective}
                      </span>
                    </Link>
                  </div>
                  <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-foreground">
                    <span
                      className={cn("h-2 w-2 rounded-full", long ? "bg-bullish" : "bg-bearish")}
                    />
                    {setup.verdict.verdict}
                  </span>
                </div>
                <div className="text-xs font-medium text-foreground/80 leading-snug line-clamp-2">
                  {setup.verdict.what_flips_it}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Confidence {Math.round(setup.verdict.confidence * 100)}%
                </div>
                <div className="mt-1 flex justify-end">
                  {decisionsAvailable ? <SkipCheckPanel symbol={setup.ticker} objective={setup.verdict.objective} direction={setup.verdict.direction} entryPrice={null} stopLoss={null} takeProfit={null} verdict={{ state: setup.verdict.state === "go" ? "live" : "not_yet", regime: universe?.market_state.regime ?? "unknown", regime_aligned: true, flip_condition: setup.verdict.what_flips_it }} context={{ accountFreshness: universe?.account.freshness ?? trust.details.account.reason, behaviorFlags: [], tradeQualityScore: setup.verdict.confidence, invalidation: setup.verdict.invalidated_by }} /> : <span className="text-[11px] font-medium text-warning">Data stale — decisions unavailable</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </IqCard>
  );
}

// Impact level -> StatusBadge tone. Direction (bullish/bearish/neutral)
// carries its own color via the dot below; the badge itself signals urgency
// (how much this deserves attention), not sentiment — mixing the two would
// make a big bullish listing render as an alarming red badge.
const IMPACT_TONE: Record<ImpactLevel, "warning" | "neutral"> = {
  high: "warning",
  medium: "warning",
  low: "neutral",
};

const DIRECTION_DOT: Record<ImpactDirection, string> = {
  bullish: "bg-bullish",
  bearish: "bg-bearish",
  neutral: "bg-muted-foreground/40",
};

/**
 * Impact-scored, deterministically ranked catalysts for the watched
 * tickers — links each item to its token's decision page rather than /check
 * (that route is still a "Coming Soon" placeholder; /token/$symbol is the
 * live, built decision surface, matching LiveSetupsStrip above). Degrades to
 * nothing when the scored-events endpoint has no medium/high rows to show.
 */
function CatalystRail() {
  const watchedTickers = useWatchlistStore((s) => s.tickers);
  const { data: events } = useCatalystRailEvents(watchedTickers);

  if (events.length === 0) return null;

  const now = Date.now();
  const ranked = [...events].sort((a, b) => b.impactScore - a.impactScore).slice(0, 3);

  return (
    <IqCard data-tour="catalyst-rail" padded={false} className="px-3 py-3 sm:px-5 sm:py-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <CardEyebrow className="shrink-0">What's Coming</CardEyebrow>
          <span className="text-[10px] text-muted-foreground">
            Impact: rule-based salience, not a forecast
          </span>
        </div>
        <div className="flex snap-x gap-4 overflow-x-auto pb-1 sm:flex-row sm:flex-wrap sm:overflow-visible sm:pb-0">
          {ranked.map((e) => {
            const hoursUntil = Math.round(
              (new Date(e.occursAt).getTime() - now) / (60 * 60 * 1000),
            );
            const timeLabel =
              hoursUntil < 48 ? `${Math.max(hoursUntil, 0)}h` : `${Math.round(hoursUntil / 24)}d`;
            return (
              <Link
                key={e.id}
                to="/token/$symbol"
                params={{ symbol: e.symbol }}
                className="flex min-w-max snap-start items-center gap-2 text-sm transition-colors hover:text-info"
              >
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", DIRECTION_DOT[e.direction])}
                  aria-hidden
                />
                <span className="font-semibold">{e.symbol}</span>
                <StatusBadge tone={IMPACT_TONE[e.impact]}>{e.impact}</StatusBadge>
                <span className="text-muted-foreground truncate max-w-[180px]">{e.title}</span>
                <span className="text-xs text-muted-foreground border border-border rounded px-1 shrink-0">
                  {timeLabel}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </IqCard>
  );
}

/**
 * Glance-level market context below the verdict: sentiment (Fear & Greed),
 * volatility, and the regime's trend + breadth pillars. Depth lives in
 * Markets — this is the "what are conditions" line the verdict rests on, so
 * the user never has to leave Today to know news/sentiment/volatility exist.
 */
function MarketContextStrip() {
  const sentiment = useSentiment();
  const volatility = useVolatility();
  const regime = useRegime();

  if (!sentiment.data || !volatility.data || !regime.data) {
    return <SkeletonCard className="h-20 w-full" />;
  }

  const fg = sentiment.data.fearGreed;
  const fgTone = fg >= 60 ? "text-bullish" : fg <= 40 ? "text-bearish" : "text-warning";
  const vol = volatility.data;
  const volTone =
    vol.label === "High" ? "text-bearish" : vol.label === "Low" ? "text-info" : "text-warning";
  const trend = regime.data.pillars.find((p) => p.label === "Trend");
  const breadth = regime.data.pillars.find((p) => p.label === "Breadth");

  return (
    <Link to="/markets" search={{ tab: "regime" }} data-tour="market-context" className="group">
      <IqCard
        padded={false}
        className="px-3 py-3 transition-colors group-hover:border-info/40 sm:px-5"
      >
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <CardEyebrow className="shrink-0">Market Context</CardEyebrow>
          <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-2 text-sm sm:justify-end sm:gap-x-5">
            <ContextStat
              icon={Gauge}
              label="Sentiment"
              value={`${fg} · ${fearGreedLabel(fg)}`}
              tone={fgTone}
            />
            <ContextStat
              icon={Activity}
              label="Volatility"
              value={`${vol.label} · ${vol.vix}% ATR`}
              tone={volTone}
              hint={`${vol.change >= 0 ? "+" : ""}${vol.change}% wk`}
            />
            {trend && <ContextStat label="Trend" value={trend.displayValue ?? `${trend.score}%`} />}
            {breadth && <ContextStat label="Breadth" value={`${breadth.score}%`} />}
          </div>
        </div>
      </IqCard>
    </Link>
  );
}

function ContextStat({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon?: React.ElementType;
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-semibold", tone)}>{value}</span>
      {hint && <span className="text-[11px] text-muted-foreground">({hint})</span>}
    </span>
  );
}

function baseTicker(symbol: string): string {
  return symbol.replace(/USDT$/, "");
}

/**
 * Derivatives Pulse — cross-symbol positioning read, one screen tall. Dee
 * trades derivatives exclusively, so this sits on Today rather than being
 * buried a tab away; every number here is already-interpreted output from
 * `/api/v1/derivatives/summary` (`backend/app/derivatives/service.py::build_summary`),
 * nothing recomputed client-side. Renders nothing until there's something to
 * show — a cold collector or an empty universe is a valid, quiet state.
 */
function DerivativesPulseStrip() {
  const summary = useDerivativesSummary();
  const data = summary.data;
  if (!data) return null;

  const topMomentum = data.top_momentum.slice(0, 3);
  const topSqueeze = data.top_squeeze.slice(0, 3);
  if (topMomentum.length === 0 && topSqueeze.length === 0) return null;

  return (
    <IqCard padded={false} className="px-3 py-3 sm:px-5 sm:py-4">
      <div className="mb-2 flex items-center justify-between">
        <CardEyebrow>Derivatives Pulse</CardEyebrow>
        <Link to="/lab" className="text-[10px] text-muted-foreground hover:text-foreground">
          Lihat Lab →
        </Link>
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        {topMomentum.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span aria-hidden>🔥</span>
            <span className="text-muted-foreground">Momentum tertinggi:</span>
            {topMomentum.map((entry, index) => (
              <span key={entry.symbol} className="whitespace-nowrap">
                <Link
                  to="/token/$symbol"
                  params={{ symbol: entry.symbol }}
                  className="font-semibold hover:text-info"
                >
                  {baseTicker(entry.symbol)} {Math.round(entry.momentum)}
                </Link>
                {index < topMomentum.length - 1 ? " · " : ""}
              </span>
            ))}
          </div>
        )}
        {topSqueeze.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span aria-hidden>⚠️</span>
            <span className="text-muted-foreground">Squeeze Risk:</span>
            {topSqueeze.map((entry, index) => (
              <span key={entry.symbol} className="whitespace-nowrap">
                <Link
                  to="/token/$symbol"
                  params={{ symbol: entry.symbol }}
                  className="font-semibold hover:text-info"
                >
                  {baseTicker(entry.symbol)} {entry.dominant_side === "long" ? "Long" : "Short"}{" "}
                  {Math.round(Math.max(entry.squeeze.long, entry.squeeze.short))}%
                </Link>
                {index < topSqueeze.length - 1 ? " · " : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    </IqCard>
  );
}

// Impact -> badge tone for the news strip (high = market-moving = alarming).
const NEWS_IMPACT_TONE: Record<string, "bearish" | "warning" | "info"> = {
  high: "bearish",
  medium: "warning",
  low: "info",
};

/** Top-3 market-moving headlines on Today; full feed lives at Markets → News. */
function TopNews() {
  const { data } = useNews();
  const top = data
    ? [...data]
        .sort((a, b) => impactRank(b.impact) - impactRank(a.impact) || a.minutesAgo - b.minutesAgo)
        .slice(0, 3)
    : undefined;

  return (
    <IqCard data-tour="top-news" padded={false} className="flex flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3 sm:px-5 sm:pt-4">
        <CardEyebrow>
          <Newspaper className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
          Market News
        </CardEyebrow>
        <Link
          to="/markets"
          search={{ tab: "news" }}
          className="text-xs font-medium text-info hover:underline"
        >
          View all →
        </Link>
      </div>
      {top ? (
        <ul className="flex flex-col divide-y divide-border">
          {top.map((n) => (
            <li key={n.id}>
              <Link
                to="/markets"
                search={{ tab: "news" }}
                className="flex gap-2 px-3 py-2.5 transition-colors hover:bg-surface/60 sm:gap-3 sm:px-5 sm:py-3"
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
                    <StatusBadge tone={NEWS_IMPACT_TONE[n.impact] ?? "info"}>
                      {n.impact}
                    </StatusBadge>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {n.assets.slice(0, 4).join(", ") || "Market-wide"}
                    </span>
                    <span className="ml-auto shrink-0">{n.minutesAgo}m ago</span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 pb-3 sm:px-5 sm:pb-4">
          <SkeletonCard className="h-24 w-full" />
        </div>
      )}
    </IqCard>
  );
}

function impactRank(impact: string): number {
  return impact === "high" ? 3 : impact === "medium" ? 2 : 1;
}
