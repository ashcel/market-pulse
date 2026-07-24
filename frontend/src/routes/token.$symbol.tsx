import { createFileRoute, notFound, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Maximize2, Minimize2, Star, Crosshair } from "lucide-react";
import { toast } from "sonner";

import { AssetIcon } from "@/components/features/asset-icon";
import { Change } from "@/components/features/change";
import type { ExecutionLogContext } from "@/components/features/execution-panel";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { MiniChart } from "@/components/features/mini-chart";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";
import { Badge } from "@/components/ui/badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useLiveKline } from "@/hooks/useLiveKline";
import { useLivePrice } from "@/hooks/useLivePrice";
import {
  usePerpContext,
  useSessionLevels,
  useTimeframeAlignment,
  useTokenSignal,
  type TokenSignalData,
} from "@/hooks/useTokenSignal";
import { normalizeTicker } from "@/lib/engine/symbol-map";
import {
  describeMarketOutlook,
  INTENTS,
  type TradingIntent,
  type ZonesByTimeframe,
} from "@/lib/engine/intent";
import { useExternalContext } from "@/hooks/useExternalContext";
import { useTokenEvents } from "@/hooks/useTokenEvents";
import {
  buildChartEvents,
  type ChartEvent,
  type PastEventLike,
  type UpcomingEventLike,
} from "@/lib/engine/event-markers";
import { useReconciledAssessments } from "@/hooks/useReconciledAssessments";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { UNIVERSE } from "@/lib/engine/market";
import { checkTradableTicker } from "@/lib/engine/symbols";
import { TOKEN_TIMEFRAMES } from "@/lib/engine/mock-candles";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import {
  computeBaseZoneCandidates,
  computeBaseZones,
  SD_ZONE_TIMEFRAMES,
  selectZoneCandidates,
} from "@/lib/engine/zones";
import { detectFvgs, selectFvgs } from "@/lib/engine/fvg";
import { detectOrderBlocks, selectOrderBlocks } from "@/lib/engine/orderblocks";
import { buildPoiMap, type UnifiedPoi } from "@/lib/engine/poi-map";
import { validateSetupFreshness, type SetupValidityResult } from "@/lib/engine/setup-validity";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { MarketStructure } from "@/lib/engine/structure";
import { formatMoney } from "@/lib/utils/format";
import { usePreferencesStore } from "@/stores/preferences";
import { useWatchlistStore } from "@/stores/watchlist";
import { useAiContext } from "@/stores/ai-context";
import type { TradeTicketState } from "@/hooks/useTradeTicket";
import { buildChartStructure, type ChartStructure } from "@/lib/ai/analyst-context";
import { cn } from "@/lib/utils";
import {
  InfoHint,
  HeaderStat,
  biasLabel,
  BiasDot,
  compute24hStats,
  formatCompact,
  structureReading,
  equilibriumReading,
} from "@/components/features/token/shared";
import { GlanceStrip } from "@/components/features/token/verdict-cards";
import {
  ChartErrorBoundary,
  TokenChart,
  computeChange24h,
} from "@/components/features/token/chart-section";
import { AssistantPanel } from "@/components/features/token/assistant-panel";
import { VerdictHeader } from "@/components/features/token/verdict-header";
import { TradeDrawer } from "@/components/features/token/trade-drawer";
import type { PlanDraft } from "@/components/features/token/chart-plan-editor";

export const Route = createFileRoute("/token/$symbol")({
  head: ({ params }) => ({
    meta: [
      { title: `${params.symbol.toUpperCase()} — Token Signal | Market Pulse` },
      {
        name: "description",
        content: `Quant signal engine, risk plan, and deterministic analyst memo for ${params.symbol.toUpperCase()}.`,
      },
    ],
  }),
  // 404 for pairs Binance doesn't list. "unknown" (directory unreachable)
  // falls through so the demo-candle path still covers offline use.
  loader: async ({ params }) => {
    const symbol = normalizeTicker(params.symbol);
    if (UNIVERSE.some((u) => u.ticker === symbol)) return;
    // Check both spot and perp — the user may switch to perp mode in the UI.
    // If the ticker is valid on either market, don't 404.
    const [spot, perp] = await Promise.all([
      checkTradableTicker({ data: { ticker: symbol, market: "spot" } }),
      checkTradableTicker({ data: { ticker: symbol, market: "perp" } }),
    ]);
    if (spot === "invalid" && perp === "invalid") throw notFound();
  },
  notFoundComponent: TokenNotFound,
  component: TokenDetailPage,
});

function TokenNotFound() {
  const { symbol } = Route.useParams();
  const ticker = normalizeTicker(symbol);
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-md text-center">
        <div className="eyebrow">404</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
          {ticker || "Token"} isn't listed
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {ticker ? `${ticker}/USDT` : "This pair"} isn't a tradable spot pair on Binance, so
          there's no live data to analyze.
        </p>
        <Link
          to="/markets"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-info px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-info/90"
        >
          Browse markets
        </Link>
      </div>
    </div>
  );
}

const TIMEFRAMES: readonly TokenTimeframe[] = TOKEN_TIMEFRAMES;

const TOUR_SEEN_KEY = "iq-token-tour-v2";

const TOUR_STEPS: TourStep[] = [
  {
    target: "header",
    title: "Token overview",
    body: "Live price, 24-hour change and key stats for this token. Use the timeframe buttons (15M up to 1W) to change the chart — everything on this page recalculates for the timeframe you pick. The tiny dot above each button is that timeframe's bias (green = leans long, red = leans short, grey = neutral), so you can spot when a short-term bounce is fighting the bigger trend.",
  },
  {
    target: "chart",
    title: "Price chart",
    body: "Each candle is one period of price movement (green = closed up, red = closed down). The legend below the chart names every overlay — EMAs, support/resistance, swing points, trade-plan levels — and clicking a legend item hides or shows it (your choices are remembered). The trade-plan levels and zones always belong to your selected objective's trigger timeframe — the legend names it (e.g. 'Trade plan · 4H') — so exploring other chart timeframes never changes the plan. When your objective's verdict wants the trade, shaded zones appear: reward (green), risk (red), and the buy/sell pocket (blue). On 1H and higher timeframes the chart also marks true demand/supply bases — consolidations that launched an explosive move. Drag the chart left past the oldest candle to load more history.",
  },
  {
    target: "insight",
    title: "Key insight & components",
    body: "The market's condition in plain words — trend, momentum, volume, volatility — plus every check the engine ran. Green passed, amber is a caution, red failed.",
  },
  {
    target: "objective",
    title: "Start with your objective",
    body: "Tell the assistant what you're trying to do — a quick scalp, an intraday trade, a multi-day swing, or a weeks-long trend position. Each objective is judged on its own pair of timeframes (a bigger one for context, a smaller one for the trigger), so the same chart can favor a scalp while ruling out a swing. The dot is each objective's verdict at a glance, and picking one switches the chart to its trigger timeframe.",
  },
  {
    target: "decision",
    title: "A verdict for YOUR objective",
    body: "Not one answer for everyone: the assistant answers for the objective you picked — go, go at reduced size, not yet, or stand aside — with the plan levels and the one thing standing in the way, all on one screen. 'Not yet' is not 'never': the Why this verdict section lists every missing confirmation and the price events that would flip today's verdict.",
  },
  {
    target: "risk",
    title: "Execution plan",
    body: "When your objective has a payable setup: entry, stop, profit targets, and a position sized from your account settings — automatically halved when the trade is counter-trend. When there's no plan, the assistant points at the objective that is payable instead.",
  },
];

function TokenDetailPage() {
  const { symbol: rawSymbol } = Route.useParams();
  const symbol = rawSymbol.toUpperCase();
  const [timeframe, setTimeframe] = useState<TokenTimeframe>("4H");
  // The AI analyst is now an on-demand drawer, closed by default so the page
  // stays focused on the decision itself.
  const setAiContext = useAiContext((s) => s.setContext);
  const [tradeOpen, setTradeOpen] = useState(false);
  // Plan-on-chart: entry/stop/target become draggable handles whose prices
  // feed the ticket + permit. The draft is seeded from the active objective's
  // plan and re-seeds whenever that plan changes (new symbol/objective).
  const [planEditMode, setPlanEditMode] = useState(false);
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);
  // Fullscreen chart: the whole price-structure card pins to the viewport so
  // the header (lean badge, timeframe pills) and legend come along. Escape
  // closes; body scroll locks while open.
  const [chartFullscreen, setChartFullscreen] = useState(false);
  useEffect(() => {
    if (!chartFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChartFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [chartFullscreen]);
  // Verdict-first layout (IA redesign §4.4): the verdict header answers the
  // page above the fold, so the evidence lives one level down in a collapsed
  // accordion. Its open sections are controlled here so the product tour can
  // expand the section a step lives in.
  const [evidenceOpen, setEvidenceOpen] = useState<string[]>([]);
  const tour = useProductTour(TOUR_SEEN_KEY);
  const tradingIntent = usePreferencesStore((s) => s.tradingIntent);
  const setTradingIntent = usePreferencesStore((s) => s.setTradingIntent);
  const marketType = usePreferencesStore((s) => s.marketType);
  const riskPrefs = usePreferencesStore((s) => s.risk);
  const leverage = usePreferencesStore((s) => s.leverage);
  // Watchlist: subscribe to membership only so the star re-renders on toggle.
  // The store's persist + useWatchlistSync push starred tokens to the server,
  // which is the set forward-test alerts treat as followed.
  const isWatched = useWatchlistStore((s) => s.tickers.includes(symbol));
  const toggleWatch = useWatchlistStore((s) => s.toggle);

  // Auto-track on open: tell the server this token was viewed so the unlock
  // pass will fetch its calendar (scope = universe + starred + opened).
  // Fire-and-forget — a failure here must never affect the page.
  useEffect(() => {
    void fetch("/api/track-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol }),
    }).catch(() => {});
  }, [symbol]);
  const signal = useTokenSignal(symbol, timeframe, marketType);
  const alignment = useTimeframeAlignment(symbol, marketType);
  const perpQuery = usePerpContext(symbol, marketType);
  const perp = marketType === "perp" ? (perpQuery.data ?? null) : null;
  const sessionQuery = useSessionLevels(symbol, marketType);
  const sessionLevels = useMemo(() => sessionQuery.data ?? [], [sessionQuery.data]);
  const biasByTimeframe = new Map(
    // The reconciled lean, not the raw setup direction — a setup the engine
    // vetoed for fighting structure/regime must not color the bias dot.
    alignment.data?.map((entry) => [entry.timeframe, entry.evaluation.lean]) ?? [],
  );
  // The chart follows the objective: picking an intent jumps to its trigger
  // timeframe. The user can still override with the timeframe buttons.
  useEffect(() => {
    const def = INTENTS.find((d) => d.intent === tradingIntent);
    if (def) setTimeframe(def.executionTimeframe);
  }, [tradingIntent]);
  const evalsByTimeframe = useMemo(() => {
    const evals: Partial<Record<TokenTimeframe, SignalEvaluation>> = {};
    for (const entry of alignment.data ?? []) evals[entry.timeframe] = entry.evaluation;
    return evals;
  }, [alignment.data]);
  const zonesByTimeframe = useMemo(() => {
    const zones: ZonesByTimeframe = {};
    for (const entry of alignment.data ?? []) zones[entry.timeframe] = entry.zones;
    return zones;
  }, [alignment.data]);
  const assessments = useReconciledAssessments(
    symbol,
    marketType,
    evalsByTimeframe,
    zonesByTimeframe,
    perp,
    sessionLevels,
    !!alignment.data,
  );
  const activeAssessment = assessments.find((a) => a.intent === tradingIntent) ?? null;
  // Re-seed the draggable plan draft whenever the active objective's plan
  // changes (new symbol/objective). A "no trade" objective (no plan/direction)
  // clears it — dragging can never fabricate a plan the verdict didn't make.
  useEffect(() => {
    const plan = activeAssessment?.plan;
    const direction = activeAssessment?.direction;
    if (!plan || (direction !== "long" && direction !== "short")) {
      setPlanDraft(null);
      return;
    }
    setPlanDraft({
      side: direction === "short" ? "SHORT" : "LONG",
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target1 ?? null,
    });
  }, [activeAssessment?.plan, activeAssessment?.direction]);

  const tradeTicketDefaults = useMemo<Partial<TradeTicketState>>(() => {
    const plan = activeAssessment?.plan;
    const direction = activeAssessment?.direction;
    // Draft (chart-dragged) overrides the engine plan when present, so the
    // ticket/permit always describe the levels currently on the chart.
    return {
      symbol: `${symbol}USDT`,
      side: planDraft?.side ?? (direction === "short" ? "SHORT" : "LONG"),
      entry_type: "LIMIT",
      entry_price: planDraft?.entry ?? plan?.entry ?? "",
      stop_price: planDraft?.stop ?? plan?.stop ?? "",
      target_price: planDraft?.target ?? plan?.target1 ?? "",
      risk_percent: riskPrefs.maxRiskPerTradePercent,
      leverage: marketType === "perp" ? leverage : 1,
      correlation_bucket: marketType === "perp" ? "crypto_perp" : "crypto_spot",
    };
  }, [
    activeAssessment?.direction,
    activeAssessment?.plan,
    planDraft,
    leverage,
    marketType,
    riskPrefs,
    symbol,
  ]);
  // Plan-derived numbers for logging a confirmed trade straight into the
  // journal (see ExecutionPanel's logContext) — undefined whenever there's
  // no live plan to log, so a fired-off "no trade" state can never write a
  // running position with fabricated numbers.
  const executionLogContext = useMemo<ExecutionLogContext | undefined>(() => {
    const plan = activeAssessment?.plan;
    const direction = activeAssessment?.direction;
    if (!plan || (direction !== "long" && direction !== "short")) return undefined;
    return {
      symbol: `${symbol}USDT`,
      direction,
      entry_price: plan.entry,
      quantity: plan.positionSize,
      leverage: marketType === "perp" ? leverage : 1,
      strategy: activeAssessment?.definition.label,
    };
  }, [activeAssessment, symbol, marketType, leverage]);
  const marketOutlook = useMemo(() => describeMarketOutlook(evalsByTimeframe), [evalsByTimeframe]);
  // Per-timeframe market structure for the alignment ladder — a projection of
  // the same alignment payload, display-only.
  const structuresByTimeframe = useMemo(() => {
    const out: Partial<Record<TokenTimeframe, MarketStructure>> = {};
    for (const [tf, ev] of Object.entries(evalsByTimeframe)) {
      out[tf as TokenTimeframe] = ev.structure;
    }
    return out;
  }, [evalsByTimeframe]);
  const data = signal.data;
  const live = useLivePrice(symbol, data?.source === "live", marketType);
  // The forming candle Binance computes for this exact timeframe, straight
  // from the kline WS stream — takes priority over the REST-polled
  // liveCandle (only refetched on useTokenSignal's ~30-60s cadence), so the
  // chart's last bar for whichever timeframe is open stays genuinely live
  // instead of lagging behind higher timeframes' slower REST cadence.
  const liveKline = useLiveKline(symbol, timeframe, data?.source === "live", marketType);
  const liveCandle = liveKline ?? data?.liveCandle ?? null;
  // `risk.entry` already anchors on the REST-fetched live price (see
  // buildRiskPlan), falling back to the last closed candle only if that fetch
  // failed — so it's a strictly better fallback than the raw candle close,
  // which reintroduces the per-timeframe staleness this is meant to avoid.
  const lastClose = live?.price ?? data?.evaluation?.risk?.entry ?? 0;
  // Setup validity: suppress stale/invalidated plans from the chart and Follow
  // button when live price has already touched the stop or moved so far past
  // the entry zone that R:R is negative. The engine core grades from closed
  // bars; this is the live-price gate the UI layer owns.
  const setupValidity: SetupValidityResult | null = activeAssessment?.plan
    ? validateSetupFreshness(
        {
          direction: activeAssessment.direction === "long" ? "long" : "short",
          entry: activeAssessment.plan.entry,
          entryLow: activeAssessment.plan.entryLow,
          entryHigh: activeAssessment.plan.entryHigh,
          stop: activeAssessment.plan.stop,
          target1: activeAssessment.plan.target1,
          target2: activeAssessment.plan.target2,
        },
        lastClose,
      )
    : null;
  const change24h = live?.change24h ?? (data ? computeChange24h(data.candles) : 0);
  const name = UNIVERSE.find((u) => u.ticker === symbol)?.name ?? symbol;

  // Dynamic document title: "$price - $TICKER - Market Pulse"
  // Updates whenever the live price ticks so the browser tab always shows the
  // latest quote. Restored to the static fallback on unmount.
  useEffect(() => {
    if (!lastClose) return;
    const priceStr =
      lastClose >= 1
        ? lastClose.toLocaleString("en-US", { maximumFractionDigits: 2 })
        : lastClose.toPrecision(5);
    document.title = `$${priceStr} - ${symbol} - Market Pulse`;
    return () => {
      document.title = "Market Pulse";
    };
  }, [lastClose, symbol]);
  const stats = useMemo(() => (data ? compute24hStats(data.candles) : null), [data]);
  const spark = useMemo(
    () => data?.candles.slice(-32).map((c, i) => ({ t: i, v: c.close })) ?? [],
    [data],
  );
  // Chart structure fed to the AI analyst so it can cross-check the plan
  // against the same demand/supply zones and S/R levels the chart draws.
  const aiBaseZones = useMemo(
    () => (data && SD_ZONE_TIMEFRAMES.includes(timeframe) ? computeBaseZones(data.candles) : []),
    [data, timeframe],
  );
  const chartStructure = useMemo<ChartStructure | null>(
    () => (data ? buildChartStructure(data.candles, data.trendLines, aiBaseZones) : null),
    [data, aiBaseZones],
  );
  // Unified POI ledger for the visible timeframe (zones + OBs + FVGs).
  // Display-only: selectPoi still consumes base zones alone (EDR 0014). Zone
  // *candidates* feed the ledger so invalidated/consumed zones stay visible,
  // flagged, instead of vanishing (EDR 0015).
  const poiMap = useMemo<UnifiedPoi[]>(
    () =>
      data && SD_ZONE_TIMEFRAMES.includes(timeframe)
        ? buildPoiMap(
            selectZoneCandidates(computeBaseZoneCandidates(data.candles)),
            selectOrderBlocks(detectOrderBlocks(data.candles)),
            selectFvgs(detectFvgs(data.candles)),
            data.candles,
            data.evaluation?.dealingRange ?? null,
          )
        : [],
    [data, timeframe],
  );
  // External market context (breadth, recent catalysts, upcoming events) —
  // secondary evidence appended to the AI analyst prompt. Absence never blocks
  // analysis: null just means the memo runs on technicals alone.
  const externalContext = useExternalContext(symbol);

  // Quick-action event overlay: the same worker-ingested news (past) + calendar
  // (upcoming) the cards show, normalized into time-anchored, tone-coloured
  // markers the chart plots and the strip lists. Recomputes only when either
  // source changes, so it re-tones as the minute-relative labels drift is fine.
  const tokenEvents = useTokenEvents(symbol);
  const chartEvents = useMemo<ChartEvent[]>(() => {
    const past: PastEventLike[] = (tokenEvents.data ?? []).map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      source: e.source,
      url: e.url,
      publishedAt: e.publishedAt,
    }));
    const ctx = externalContext.data;
    const upcoming: UpcomingEventLike[] = [
      ...(ctx?.upcoming ?? []),
      ...(ctx?.marketEvents ?? []),
    ].map((e) => ({
      kind: e.kind,
      title: e.title,
      source: e.source,
      url: e.url,
      occursAt: e.occursAt,
    }));
    return buildChartEvents(past, upcoming);
  }, [tokenEvents.data, externalContext.data]);

  useEffect(() => {
    if (data?.evaluation) {
      setAiContext({
        symbol,
        timeframe,
        evaluation: data.evaluation,
        assessment: activeAssessment,
        // Full per-intent map — already computed above for every objective, not
        // just the active one — so the AI Desk Review can match evidence to
        // whichever intent the trader's free-text idea parses to, not just
        // whatever tab happens to be open.
        assessments: Object.fromEntries(assessments.map((a) => [a.intent, a])) as Partial<
          Record<TradingIntent, DisplayIntentAssessment>
        >,
        chartStructure,
        externalContext: externalContext.data,
      });
    }
    return () => setAiContext(null);
  }, [
    symbol,
    timeframe,
    data?.evaluation,
    activeAssessment,
    assessments,
    chartStructure,
    externalContext.data,
    setAiContext,
  ]);

  return (
    // Locked to the viewport on desktop: only the right panel and chat scroll.
    <div className="mx-auto flex w-full max-w-[1700px] flex-col gap-3 lg:h-[calc(100dvh-7rem)] lg:min-h-0">
      <IqCard
        padded={false}
        data-tour="header"
        className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <AssetIcon ticker={symbol} className="h-8 w-8 text-sm" />
          <div className="leading-tight">
            <h1 className="text-lg font-bold tracking-tight">{symbol}</h1>
            <div className="text-[11px] text-muted-foreground">
              {name} / USDT{marketType === "perp" ? " · Perp" : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              toggleWatch(symbol);
              toast.success(isWatched ? `Removed ${symbol} from watchlist` : `Watching ${symbol}`);
            }}
            aria-pressed={isWatched}
            aria-label={isWatched ? `Unwatch ${symbol}` : `Watch ${symbol}`}
            title={isWatched ? "In your watchlist — click to remove" : "Add to watchlist"}
            className={cn(
              "rounded-md border border-border bg-surface p-2 transition-colors hover:text-foreground",
              isWatched ? "text-warning" : "text-muted-foreground",
            )}
          >
            <Star className={cn("h-4 w-4", isWatched && "fill-warning")} />
          </button>
        </div>

        {signal.isLoading ? (
          <span className="h-7 w-40 animate-pulse rounded bg-muted" />
        ) : (
          <div className="flex items-center gap-2.5">
            <span className="num text-xl font-semibold tracking-tight">
              {formatMoney(lastClose)}
            </span>
            <Change value={change24h} showIcon />
            <div className="hidden w-24 sm:block">
              <MiniChart data={spark} tone={change24h >= 0 ? "bullish" : "bearish"} height={26} />
            </div>
            <Badge
              variant="outline"
              className={cn(
                "uppercase",
                data?.source === "live"
                  ? "border-bullish/30 bg-bullish-soft text-bullish"
                  : "border-warning/30 bg-warning-soft text-warning",
              )}
            >
              {live ? (
                <span className="flex items-center gap-1.5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bullish opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-bullish" />
                  </span>
                  Live
                </span>
              ) : data?.source === "live" ? (
                "Live"
              ) : (
                "Demo"
              )}
            </Badge>
          </div>
        )}

        <div className="ml-auto flex items-center gap-4">
          <div className="grid grid-cols-6 rounded-md border border-border bg-surface p-0.5 text-xs">
            {TIMEFRAMES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTimeframe(item)}
                title={biasLabel(item, biasByTimeframe.get(item))}
                className={cn(
                  "flex h-9 flex-col items-center justify-center gap-1 rounded px-2.5 font-semibold transition-colors",
                  timeframe === item
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <BiasDot direction={biasByTimeframe.get(item)} />
                {item}
              </button>
            ))}
          </div>
          {stats && (
            <div className="hidden items-center gap-5 border-l border-border pl-4 xl:flex">
              <HeaderStat label="24h High" value={formatMoney(stats.high)} />
              <HeaderStat label="24h Low" value={formatMoney(stats.low)} />
              <HeaderStat label="24h Volume" value={`${formatCompact(stats.volume)} ${symbol}`} />
              <HeaderStat label="24h Turnover" value={`$${formatCompact(stats.turnover)}`} />
            </div>
          )}
          <HelpButton onClick={tour.start} />
        </div>
      </IqCard>

      {signal.isLoading || !data ? (
        <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,25rem)_auto]">
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <IqCard padded={false} className="overflow-hidden lg:min-h-0 lg:flex-1">
              <div className="h-[360px] animate-pulse bg-surface lg:h-full" />
            </IqCard>
            <IqCard className="h-28 shrink-0 animate-pulse bg-surface" />
          </div>
          <IqCard className="h-96 animate-pulse bg-surface lg:h-full" />
          <IqCard className="hidden w-[300px] animate-pulse bg-surface lg:block lg:h-full" />
        </div>
      ) : (
        <TooltipProvider delayDuration={150}>
          {/* LAYER 1 — the verdict header answers the page and never scrolls
              away behind a tab: per-objective chips, the active verdict, the
              catalyst line, and the Check entry point. */}
          <VerdictHeader
            symbol={symbol}
            assessments={assessments}
            active={activeAssessment}
            activeIntent={tradingIntent}
            onSelect={setTradingIntent}
          />

          <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,27rem)]">
            <div className="flex min-h-0 min-w-0 flex-col gap-3">
              <ChartErrorBoundary>
                <IqCard
                  padded={false}
                  data-tour="chart"
                  className={cn(
                    "flex flex-col overflow-hidden",
                    chartFullscreen
                      ? "fixed inset-0 z-50 rounded-none border-0 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
                      : "lg:min-h-0 lg:flex-1",
                  )}
                >
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border px-3 py-2 sm:px-4">
                    <div className="flex min-w-0 items-baseline gap-3">
                      <div className="flex items-center gap-1.5">
                        <CardEyebrow>{chartFullscreen ? symbol : "Price Structure"}</CardEyebrow>
                        {!chartFullscreen && (
                          <InfoHint text="Candlestick chart of the selected timeframe. The legend below the chart explains every overlay — click an item to hide or show it. Drag the chart past the oldest candle to load more history. The expand button opens the chart fullscreen." />
                        )}
                      </div>
                      <span className="hidden text-xs text-muted-foreground md:inline">
                        {data.candles.length} {data.source === "live" ? "Binance" : "synthetic"}{" "}
                        bars · {data.evaluation.structure.swings.length} swings ·{" "}
                        {structureReading(data.evaluation.structure)}
                        {equilibriumReading(data.evaluation)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {chartFullscreen && (
                        <div className="flex rounded-md border border-border bg-surface p-0.5 text-[11px]">
                          {TIMEFRAMES.map((item) => (
                            <button
                              key={item}
                              type="button"
                              onClick={() => setTimeframe(item)}
                              className={cn(
                                "rounded px-2 py-1.5 font-semibold transition-colors",
                                timeframe === item
                                  ? "bg-card text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {item}
                            </button>
                          ))}
                        </div>
                      )}
                      <Badge
                        variant="outline"
                        className={cn(
                          "border-info/30 bg-info-soft text-info",
                          chartFullscreen && "hidden sm:inline-flex",
                        )}
                      >
                        {timeframe} lean:{" "}
                        {data.evaluation.lean === "none" ? "neutral" : data.evaluation.lean}
                      </Badge>
                      {planDraft && (
                        <button
                          type="button"
                          onClick={() => {
                            setPlanEditMode((v) => {
                              const next = !v;
                              if (next) setTradeOpen(true);
                              return next;
                            });
                          }}
                          aria-pressed={planEditMode}
                          className={cn(
                            "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition-colors",
                            planEditMode
                              ? "border-info bg-info-soft text-info"
                              : "border-border bg-surface text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Crosshair className="h-3.5 w-3.5" />
                          {planEditMode ? "Editing plan" : "Plan on chart"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setChartFullscreen((v) => !v)}
                        aria-label={chartFullscreen ? "Exit fullscreen chart" : "Fullscreen chart"}
                        className="rounded-md border border-border bg-surface p-2 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {chartFullscreen ? (
                          <Minimize2 className="h-3.5 w-3.5" />
                        ) : (
                          <Maximize2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col lg:min-h-[240px]">
                    {data?.candles.length > 0 && (
                      <TokenChart
                        {...data}
                        liveCandle={liveCandle}
                        symbol={symbol}
                        timeframe={timeframe}
                        market={marketType}
                        sessionLevels={sessionLevels}
                        events={chartEvents}
                        fillHeight={chartFullscreen}
                        plan={activeAssessment?.plan ?? null}
                        planTimeframe={activeAssessment?.definition.executionTimeframe ?? null}
                        planStrong={
                          (activeAssessment?.verdict === "favored" ||
                            activeAssessment?.verdict === "caution") &&
                          setupValidity?.valid !== false
                        }
                        onTrade={() => setTradeOpen(true)}
                        planEditable={planEditMode}
                        planDraft={planDraft}
                        onPlanDraftChange={setPlanDraft}
                      />
                    )}
                  </div>
                </IqCard>
              </ChartErrorBoundary>

              <GlanceStrip
                assessment={activeAssessment}
                evaluation={data.evaluation}
                timeframe={timeframe}
                candles={data.candles}
              />
            </div>

            <AssistantPanel
              symbol={symbol}
              assessments={assessments}
              active={activeAssessment}
              marketOutlook={marketOutlook}
              structuresByTimeframe={structuresByTimeframe}
              perp={perp}
              sessionLevels={sessionLevels}
              price={lastClose}
              liveData={data.source === "live"}
              poiMap={poiMap}
              poiTimeframe={timeframe}
              setupValidity={setupValidity}
              evidenceOpen={evidenceOpen}
              onEvidenceOpen={setEvidenceOpen}
              onOpenTrade={() => setTradeOpen(true)}
              className="lg:h-full lg:min-h-0"
            />
          </div>

          <TradeDrawer
            symbol={symbol}
            ticket={tradeTicketDefaults}
            logContext={executionLogContext}
            open={tradeOpen}
            onOpenChange={setTradeOpen}
            timeframe={timeframe}
            evaluation={data.evaluation}
            assessment={activeAssessment}
            chartStructure={chartStructure}
            externalContext={externalContext.data ?? null}
          />

          <div className="hidden shrink-0 items-center justify-between rounded-lg border border-border bg-card px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground lg:flex">
            <div className="flex items-center gap-2">
              <span>
                Last updated:{" "}
                <span className="num text-foreground">
                  {new Date(signal.dataUpdatedAt || Date.now()).toLocaleTimeString()}
                </span>
              </span>
              <span
                className={cn(
                  "flex items-center gap-1 font-semibold",
                  data.source === "live" ? "text-bullish" : "text-warning",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    data.source === "live" ? "bg-bullish" : "bg-warning",
                  )}
                />
                {data.source === "live" ? "Live" : "Demo"}
              </span>
            </div>
            <span>
              Data source: {data.source === "live" ? "Binance" : "Synthetic (Binance unreachable)"}
            </span>
            <span>
              Auto-refresh: <span className="text-bullish">On</span>
            </span>
          </div>
        </TooltipProvider>
      )}

      <ProductTour
        steps={TOUR_STEPS}
        open={tour.open && !signal.isLoading}
        onClose={tour.close}
        onStepChange={(target) => {
          // Verdict, objective, and plan now live in always-visible layers;
          // only the "insight" step points into the collapsed evidence
          // accordion, so open its "Why this verdict" section before the
          // spotlight measures the target (ProductTour re-measures after 120ms).
          if (target === "insight") {
            setEvidenceOpen((prev) => (prev.includes("why") ? prev : [...prev, "why"]));
          }
        }}
      />
    </div>
  );
}
