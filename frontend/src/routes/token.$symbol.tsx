import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
} from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import type {
  CandlestickData,
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  LineData,
  LogicalRange,
  SeriesDataItemTypeMap,
  SeriesMarker,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import {
  Activity,
  Bookmark,
  BookmarkCheck,
  Bot,
  Brain,
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  CircleX,
  History,
  Layers,
  Lock,
  MoveRight,
  Maximize2,
  Minimize2,
  Play,
  Scale,
  Send,
  ShieldAlert,
  ShieldCheck,
  Star,
  Target,
  TrendingDown,
  TrendingUp,
  Waves,
  Waypoints,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Link } from "@tanstack/react-router";

import { AnticipatoryReadCard } from "@/components/features/anticipatory-read-card";
import { FundingPlayPanel } from "@/components/features/funding-play-panel";
import { PoiMapCard } from "@/components/features/poi-map-card";
import { summarizeAnticipatoryRecord } from "@/lib/engine/anticipatory";
import { useAnticipatorySignalsStore } from "@/stores/anticipatory-signals";
import { AssetIcon } from "@/components/features/asset-icon";
import { Change } from "@/components/features/change";
import { ChartEventPopup, ChartEventStrip } from "@/components/features/chart-event-strip";
import { ZonesPrimitive, type PriceZone } from "@/components/features/chart-zones";
import { ConfidenceGauge } from "@/components/features/confidence-gauge";
import { ExecutionPanel, type ExecutionLogContext } from "@/components/features/execution-panel";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { MiniChart } from "@/components/features/mini-chart";
import { TradeActionOverlay } from "@/components/features/trade-action-overlay";
import { StructureAlignmentCard } from "@/components/features/structure-alignment-card";
import { TokenEventsCard } from "@/components/features/token-events-card";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLiveKline } from "@/hooks/useLiveKline";
import { useLivePrice } from "@/hooks/useLivePrice";
import {
  usePerpContext,
  useSessionLevels,
  useTimeframeAlignment,
  useTokenSignal,
  type TokenSignalData,
} from "@/hooks/useTokenSignal";
import type { PerpRead } from "@/lib/engine/perp";
import type { SessionLevel } from "@/lib/engine/sessions";
import type { TradeDirection } from "@/lib/engine/quant";
import { normalizeTicker } from "@/lib/engine/symbol-map";
import {
  describeMarketOutlook,
  INTENTS,
  type IntentAssessment,
  type TradingIntent,
  type ZonesByTimeframe,
} from "@/lib/engine/intent";
import { useExternalContext } from "@/hooks/useExternalContext";
import { useTokenEvents } from "@/hooks/useTokenEvents";
import {
  TONE_HEX,
  buildChartEvents,
  kindLabel,
  snapToCandle,
  type ChartEvent,
  type PastEventLike,
  type UpcomingEventLike,
} from "@/lib/engine/event-markers";
import type { ExternalContext } from "@/lib/engine/external-context";
import { useReconciledAssessments } from "@/hooks/useReconciledAssessments";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { computeEmaSeries } from "@/lib/engine/analysis";
import { fetchBinanceKlines, type MarketType } from "@/lib/engine/binance";
import type { Candle } from "@/lib/engine/types";
import { UNIVERSE } from "@/lib/engine/market";
import { checkTradableTicker } from "@/lib/engine/symbols";
import { TOKEN_TIMEFRAMES } from "@/lib/engine/mock-candles";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import {
  computeBaseZoneCandidates,
  computeBaseZones,
  SD_ZONE_TIMEFRAMES,
  selectZoneCandidates,
  type BaseZone,
} from "@/lib/engine/zones";
import { detectFvgs, selectFvgs } from "@/lib/engine/fvg";
import { detectOrderBlocks, selectOrderBlocks } from "@/lib/engine/orderblocks";
import { buildPoiMap, TERMINAL_POI_STATES, type UnifiedPoi } from "@/lib/engine/poi-map";
import { validateSetupFreshness, type SetupValidityResult } from "@/lib/engine/setup-validity";
import { currentSweep, gradeRisk } from "@/lib/engine/quant";
import type {
  MarketRegime,
  RiskRewardPlan,
  SetupType,
  SignalEvaluation,
  SignalStatus,
} from "@/lib/engine/quant";
import type { MarketStructure } from "@/lib/engine/structure";
import { formatEntryRange, formatMoney, formatUnits } from "@/lib/utils/format";
import { computeLeverageMetrics, MAX_LEVERAGE, MIN_LEVERAGE } from "@/lib/utils/leverage";
import { usePreferencesStore, type ChartIndicatorKey } from "@/stores/preferences";
import { useWatchlistStore } from "@/stores/watchlist";
import { NotSignedInError, useFollowSignal, useTrackedFollows } from "@/hooks/useTrackedFollows";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { useAiContext } from "@/stores/ai-context";
import type { TradeTicketState } from "@/hooks/useTradeTicket";
import { resolveAiConfig } from "@/lib/ai/providers";
import { runAiAnalyst, type AiMessage } from "@/lib/ai/client";
import {
  buildAnalystSystem,
  buildChartStructure,
  type ChartStructure,
} from "@/lib/ai/analyst-context";
import { MarkdownText } from "@/components/features/markdown-text";
import { cn } from "@/lib/utils";

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

const EMA_FAST = { length: 13, color: "#38bdf8" };
const EMA_SLOW = { length: 21, color: "#a78bfa" };

// Session H/L lines are only meaningful on intraday charts; on daily/weekly
// they'd just clutter far below/above the visible action.
const SESSION_LINE_TIMEFRAMES: readonly TokenTimeframe[] = ["15M", "30M", "1H", "4H"];
const SESSION_LINE_COLORS: Record<string, string> = {
  asia: "#f472b6", // pink
  eu: "#2dd4bf", // teal
  us: "#fb923c", // orange
};

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
    body: "Not one answer for everyone: the assistant answers for the objective you picked — go, go at reduced size, not yet, or stand aside — with the plan levels and the one thing standing in the way, all on one screen. 'Not yet' is not 'never': the Why tab lists every missing confirmation and the price events that would flip today's verdict.",
  },
  {
    target: "risk",
    title: "Execution plan",
    body: "When your objective has a payable setup: entry, stop, profit targets, and a position sized from your account settings — automatically halved when the trade is counter-trend. When there's no plan, the assistant points at the objective that is payable instead.",
  },
];

class ChartErrorBoundary extends React.Component<
  { children: ReactElement },
  { hasError: boolean }
> {
  constructor(props: { children: ReactElement }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    // Lightweight-charts "Value is null" bug: chart is still usable, just suppress the error
    if (error.message.includes("Value is null")) {
      return;
    }
    console.error("Chart error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <IqCard padded={false} className="flex flex-col overflow-hidden lg:min-h-0 lg:flex-1">
          <div className="h-full w-full bg-surface flex items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-muted-foreground">Chart encountered an issue</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-2 text-xs text-info hover:underline"
              >
                Reload page
              </button>
            </div>
          </div>
        </IqCard>
      );
    }
    return this.props.children;
  }
}

function TokenDetailPage() {
  const { symbol: rawSymbol } = Route.useParams();
  const symbol = rawSymbol.toUpperCase();
  const [timeframe, setTimeframe] = useState<TokenTimeframe>("4H");
  // The AI analyst is now an on-demand drawer, closed by default so the page
  // stays focused on the decision itself.
  const setAiContext = useAiContext((s) => s.setContext);
  const [tradeOpen, setTradeOpen] = useState(false);
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
  // The decision panel is organized into tabs that follow the trader's flow
  // (Should I? → Why? → Where? → Risk? → Evidence). Controlled so the product
  // tour can jump to the tab a step lives in.
  const [activeTab, setActiveTab] = useState("overview");
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
  const tradeTicketDefaults = useMemo<Partial<TradeTicketState>>(() => {
    const plan = activeAssessment?.plan;
    const direction = activeAssessment?.direction;
    return {
      symbol: `${symbol}USDT`,
      side: direction === "short" ? "SHORT" : "LONG",
      entry_type: "LIMIT",
      entry_price: plan?.entry ?? "",
      stop_price: plan?.stop ?? "",
      target_price: plan?.target1 ?? "",
      risk_percent: riskPrefs.maxRiskPerTradePercent,
      leverage: marketType === "perp" ? leverage : 1,
      correlation_bucket: marketType === "perp" ? "crypto_perp" : "crypto_spot",
    };
  }, [
    activeAssessment?.direction,
    activeAssessment?.plan,
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
              activeIntent={tradingIntent}
              marketOutlook={marketOutlook}
              structuresByTimeframe={structuresByTimeframe}
              perp={perp}
              sessionLevels={sessionLevels}
              price={lastClose}
              liveData={data.source === "live"}
              poiMap={poiMap}
              poiTimeframe={timeframe}
              setupValidity={setupValidity}
              onSelect={setTradingIntent}
              activeTab={activeTab}
              onTabChange={setActiveTab}
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
          // Each tour step lives on a specific tab — surface it before the
          // spotlight measures the target (ProductTour re-measures after 120ms).
          const tabForTarget: Record<string, string> = {
            objective: "overview",
            decision: "overview",
            risk: "plan",
            insight: "details",
          };
          const tab = tabForTarget[target];
          if (tab) setActiveTab(tab);
        }}
      />
    </div>
  );
}

function biasLabel(timeframe: TokenTimeframe, direction: TradeDirection | undefined): string {
  if (direction === "long") return `${timeframe}: engine leans long`;
  if (direction === "short") return `${timeframe}: engine leans short`;
  return `${timeframe}: no directional bias`;
}

function BiasDot({ direction }: { direction: TradeDirection | undefined }) {
  return (
    <span
      className={cn(
        "h-1 w-1 rounded-full",
        direction === "long" && "bg-bullish",
        direction === "short" && "bg-bearish",
        (direction === "none" || direction === undefined) && "bg-muted-foreground/30",
      )}
    />
  );
}

function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="What is this?"
          className="text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <CircleHelp className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] bg-popover text-xs leading-relaxed text-popover-foreground shadow-lg">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="num mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}

function compute24hStats(candles: TokenSignalData["candles"]) {
  const lastCandle = candles.at(-1);
  if (!lastCandle) return null;
  const window = candles.filter((c) => c.time >= lastCandle.time - 24 * 60 * 60);
  if (window.length === 0) return null;
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
    volume: window.reduce((sum, c) => sum + c.volume, 0),
    turnover: window.reduce((sum, c) => sum + c.volume * c.close, 0),
  };
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(
    value,
  );
}

type IndicatorKey = ChartIndicatorKey;

// Bars fetched per page when the user drags past the oldest loaded candle.
const HISTORY_PAGE = 500;

// Most recent swing legs drawn as labeled chart markers; older legs sit
// outside the story the current structure tells and would only add clutter.
const MAX_STRUCTURE_MARKERS = 8;

/** One-glance summary of the swing structure for the chart header. */
function structureReading(structure: MarketStructure): string {
  if (structure.trend === "uptrend") return "HH/HL uptrend";
  if (structure.trend === "downtrend") return "LH/LL downtrend";
  return "range structure";
}

/**
 * Passive premium/discount read of this chart timeframe's dealing range
 * (Phase 0 instrumentation — annotation only, no verdict behind it). Empty
 * until the engine has a range to measure against.
 */
function equilibriumReading(evaluation: SignalEvaluation): string {
  const { dealingRange, pricePosition } = evaluation;
  if (!dealingRange || !pricePosition) return "";
  const range = `${formatMoney(dealingRange.low.price)}–${formatMoney(dealingRange.high.price)}`;
  return ` · ${pricePosition} of ${range}`;
}

function humanSetup(setup: SetupType): string {
  return setup
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

type GlanceTone = "bullish" | "bearish" | "warning" | "info" | "neutral" | "muted";

const GLANCE_TONE_TEXT: Record<GlanceTone, string> = {
  bullish: "text-bullish",
  bearish: "text-bearish",
  warning: "text-warning",
  info: "text-info",
  neutral: "text-foreground",
  muted: "text-muted-foreground",
};

interface GlanceChip {
  icon: typeof Activity;
  label: string;
  value: string;
  sub: string;
  tone: GlanceTone;
}

/**
 * The five reads a trader needs before anything else, each straight from the
 * engine: HTF trend (the active objective's context lean), the chart
 * timeframe's regime + setup, its swing structure with the live BOS/CHoCH,
 * the liquidity state (recent sweep, else intact pools), and where the active
 * objective's entry sits relative to structure.
 */
function buildGlanceChips(
  assessment: DisplayIntentAssessment | null,
  evaluation: SignalEvaluation,
  timeframe: TokenTimeframe,
  candles: Candle[],
): GlanceChip[] {
  const chips: GlanceChip[] = [];

  // 1 — Higher-timeframe trend, from the objective's reconciled context lean.
  if (assessment) {
    const bias = assessment.contextBias;
    chips.push({
      icon: bias === "long" ? TrendingUp : bias === "short" ? TrendingDown : MoveRight,
      label: `${assessment.definition.contextTimeframe} trend`,
      value: bias === "long" ? "Bullish" : bias === "short" ? "Bearish" : "Neutral",
      sub: assessment.context.regime.replaceAll("-", " "),
      tone: bias === "long" ? "bullish" : bias === "short" ? "bearish" : "neutral",
    });
  } else {
    chips.push({
      icon: MoveRight,
      label: "HTF trend",
      value: "—",
      sub: "assessing…",
      tone: "muted",
    });
  }

  // 2 — The chart timeframe's regime, with the classified setup as detail.
  const regimeTone: GlanceTone =
    evaluation.regime === "trending-up"
      ? "bullish"
      : evaluation.regime === "trending-down"
        ? "bearish"
        : evaluation.regime === "high-volatility" || evaluation.regime === "choppy"
          ? "warning"
          : evaluation.regime === "breakout-compression" || evaluation.regime === "mean-reversion"
            ? "info"
            : "neutral";
  chips.push({
    icon: Activity,
    label: `${timeframe} state`,
    value: evaluation.regime.replaceAll("-", " "),
    sub:
      evaluation.setupType === "no-clear-setup"
        ? "no clear setup"
        : humanSetup(evaluation.setupType),
    tone: regimeTone,
  });

  // 3 — Swing structure, with the break event only while it is still live.
  const s = evaluation.structure;
  const eventCurrent =
    s.event && s.eventSwing && (s.eventSwing === s.lastHigh || s.eventSwing === s.lastLow);
  const eventSub = eventCurrent
    ? s.event === "bos"
      ? "BOS — trend confirmed"
      : "CHoCH — reversal risk"
    : `last ${s.lastHigh?.label ?? "–"} high · ${s.lastLow?.label ?? "–"} low`;
  chips.push({
    icon: Waypoints,
    label: "Structure",
    value: s.trend === "uptrend" ? "HH / HL" : s.trend === "downtrend" ? "LH / LL" : "Range",
    sub: eventSub,
    tone: s.trend === "uptrend" ? "bullish" : s.trend === "downtrend" ? "bearish" : "neutral",
  });

  // 4 — Liquidity: a live sweep is the headline; otherwise the intact pools.
  // Recency is the engine's own rule (currentSweep), so this chip headlines a
  // raid exactly while setup classification still treats it as a trigger.
  const sweeps = evaluation.liquiditySweeps;
  const recentSweep = currentSweep(sweeps, candles);
  if (recentSweep) {
    chips.push({
      icon: Waves,
      label: "Liquidity",
      value: recentSweep.side === "ssl" ? "SSL swept" : "BSL swept",
      sub: recentSweep.side === "ssl" ? "stop hunt below — fuel up" : "stop hunt above — fuel down",
      tone: recentSweep.side === "ssl" ? "bullish" : "bearish",
    });
  } else {
    const sweptPools = new Set(sweeps.map((sweep) => sweep.pool));
    const intact = evaluation.liquidity.filter((pool) => pool.intact && !sweptPools.has(pool));
    const bsl = intact.filter((pool) => pool.side === "bsl").length;
    const ssl = intact.length - bsl;
    const parts = [bsl > 0 ? `${bsl} BSL` : null, ssl > 0 ? `${ssl} SSL` : null].filter(Boolean);
    chips.push({
      icon: Waves,
      label: "Liquidity",
      value: parts.length ? parts.join(" · ") : "None mapped",
      sub: parts.length ? "intact pools — price magnets" : "no equal highs/lows",
      tone: parts.length ? "info" : "muted",
    });
  }

  // 5 — Entry location for the active objective's direction.
  const location = assessment?.location ?? null;
  if (location) {
    chips.push({
      icon: Target,
      label: "Entry location",
      value: location.label,
      sub:
        location.confluence === "multi-timeframe"
          ? "MTF zone confluence"
          : location.confluence === "single-timeframe"
            ? "zone-backed"
            : `${Math.round(Math.min(1, Math.max(0, location.rangePosition)) * 100)}% of S→R range`,
      tone:
        location.grade === "at-structure"
          ? "bullish"
          : location.grade === "extended"
            ? "warning"
            : "info",
    });
  } else {
    chips.push({
      icon: Target,
      label: "Entry location",
      value: "—",
      sub: "no directional read",
      tone: "muted",
    });
  }

  return chips;
}

/**
 * Glanceable market read under the chart — five chips a trader can absorb in
 * seconds, mirroring the same engine state the verdict panel reasons from.
 */
function GlanceStrip({
  assessment,
  evaluation,
  timeframe,
  candles,
}: {
  assessment: DisplayIntentAssessment | null;
  evaluation: SignalEvaluation;
  timeframe: TokenTimeframe;
  candles: Candle[];
}) {
  const chips = buildGlanceChips(assessment, evaluation, timeframe, candles);
  return (
    <IqCard
      padded={false}
      className="grid shrink-0 grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:divide-border"
    >
      {chips.map((chip) => (
        <div key={chip.label} className="flex min-w-0 items-center gap-2.5 px-3 py-2">
          <chip.icon className={cn("h-4 w-4 shrink-0", GLANCE_TONE_TEXT[chip.tone])} />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              {chip.label}
            </div>
            <div
              className={cn(
                "truncate text-xs font-bold capitalize",
                GLANCE_TONE_TEXT[chip.tone === "muted" ? "muted" : chip.tone],
              )}
            >
              {chip.value}
            </div>
            <div className="truncate text-[9px] text-muted-foreground">{chip.sub}</div>
          </div>
        </div>
      ))}
    </IqCard>
  );
}

function TokenChart({
  symbol,
  timeframe,
  market,
  candles,
  trendLines,
  evaluation,
  source,
  liveCandle,
  sessionLevels,
  fillHeight,
  plan,
  planTimeframe,
  planStrong,
  events,
  onTrade,
}: TokenSignalData & {
  symbol: string;
  timeframe: TokenTimeframe;
  market: MarketType;
  sessionLevels: SessionLevel[];
  /** Normalized news (past) + calendar (upcoming) events for the overlay. */
  events: ChartEvent[];
  /** Fill the parent instead of the fixed mobile heights (fullscreen mode). */
  fillHeight?: boolean;
  /**
   * The active objective's execution-timeframe plan — NOT this chart
   * timeframe's `evaluation.risk`. The candles follow whatever timeframe the
   * user explores, but the plan overlays always tell the one trade story the
   * assistant panel is quoting; `planTimeframe` labels their source in the
   * legend so the split is explicit.
   */
  plan: RiskRewardPlan | null;
  planTimeframe: TokenTimeframe | null;
  /** True when the verdict actually wants the trade (favored/caution) — gates the shaded zones. */
  planStrong: boolean;
  onTrade?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const supportSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const resistanceSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const entrySeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stopSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const target1SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const target2SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaFastSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaSlowSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markerRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const zonesPrimitiveRef = useRef<ZonesPrimitive | null>(null);

  // Event overlay: which chart events share each bar (keyed by that bar's time),
  // rebuilt alongside the markers so a chart click can look them up. The click
  // subscription is bound once at mount, so it reads through the ref, never a
  // stale closure. The popup is the detail card; focusedEventId rings the strip.
  const eventIndexRef = useRef<Map<number, ChartEvent[]>>(new Map());
  const [eventPopup, setEventPopup] = useState<{
    x: number;
    y: number;
    events: ChartEvent[];
  } | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);

  // Older bars paged in when the user drags past the left edge of the data.
  const historyRef = useRef<{
    key: string;
    candles: Candle[];
    exhausted: boolean;
    loading: boolean;
  }>({ key: "", candles: [], exhausted: false, loading: false });
  const [historyVersion, setHistoryVersion] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const appliedKeyRef = useRef("");
  // Bounded next-frame retries of the data pass when lightweight-charts throws
  // its "Value is null" time-scale bug (see the catch below for the details).
  const chartRetriesRef = useRef(0);
  const [chartRetry, setChartRetry] = useState(0);
  const appliedPrecisionRef = useRef<number | null>(null);
  const earliestTimeRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const loadOlderRef = useRef<() => void>(() => {});

  const hiddenIndicators = usePreferencesStore((s) => s.hiddenChartIndicators);
  const toggleIndicator = usePreferencesStore((s) => s.toggleChartIndicator);

  const baseZones = useMemo(
    () => (SD_ZONE_TIMEFRAMES.includes(timeframe) ? computeBaseZones(candles) : []),
    [candles, timeframe],
  );
  // OB/FVG overlays share the zone timeframe gate and the S/D toggle; zones
  // themselves keep their own band family so the two never double-draw.
  const obFvgPois = useMemo(
    () =>
      SD_ZONE_TIMEFRAMES.includes(timeframe)
        ? buildPoiMap(
            [],
            selectOrderBlocks(detectOrderBlocks(candles)),
            selectFvgs(detectFvgs(candles)),
            candles,
            null,
          )
        : [],
    [candles, timeframe],
  );

  const loadOlder = useCallback(async () => {
    const history = historyRef.current;
    const earliest = earliestTimeRef.current;
    if (history.loading || history.exhausted || earliest === null || source !== "live") return;
    history.loading = true;
    setLoadingHistory(true);
    try {
      const older = await fetchBinanceKlines(
        symbol,
        timeframe,
        HISTORY_PAGE,
        earliest * 1000 - 1,
        market,
      );
      const fresh = older.filter((c) => c.time < earliest);
      if (fresh.length === 0) {
        history.exhausted = true;
      } else {
        history.candles = [...fresh, ...history.candles];
        setHistoryVersion((version) => version + 1);
      }
    } finally {
      history.loading = false;
      setLoadingHistory(false);
    }
  }, [symbol, timeframe, source, market]);
  loadOlderRef.current = loadOlder;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      width: Math.max(host.clientWidth, 1),
      height: Math.max(host.clientHeight, 1),
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.64)",
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.06)" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: { borderColor: "rgba(255,255,255,0.1)", rightOffset: 8, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#f43f5e",
      wickUpColor: "#22c55e",
      wickDownColor: "#f43f5e",
      borderVisible: false,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    const trendOptions = (color: string) => ({
      color,
      lineWidth: 1 as const,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const levelOptions = (color: string, lineStyle = LineStyle.Solid) => ({
      color,
      lineWidth: 1 as const,
      lineStyle,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    });
    const emaOptions = (color: string) => ({
      color,
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    supportSeriesRef.current = chart.addSeries(LineSeries, trendOptions("#22c55e"));
    resistanceSeriesRef.current = chart.addSeries(LineSeries, trendOptions("#f59e0b"));
    entrySeriesRef.current = chart.addSeries(LineSeries, levelOptions("#60a5fa"));
    stopSeriesRef.current = chart.addSeries(LineSeries, levelOptions("#f43f5e"));
    target1SeriesRef.current = chart.addSeries(LineSeries, levelOptions("#22c55e"));
    target2SeriesRef.current = chart.addSeries(
      LineSeries,
      levelOptions("#22c55e", LineStyle.Dashed),
    );
    emaFastSeriesRef.current = chart.addSeries(LineSeries, emaOptions(EMA_FAST.color));
    emaSlowSeriesRef.current = chart.addSeries(LineSeries, emaOptions(EMA_SLOW.color));
    markerRef.current = createSeriesMarkers(candleSeries);

    // Clicking a bar that carries event markers opens their detail card. Bound
    // once — the handler reads the live index + point through refs/state setters
    // (all stable), so it never needs re-subscribing. chart.remove() (cleanup
    // below) tears the subscription down with the chart.
    chart.subscribeClick((param) => {
      const time = param.time as number | undefined;
      const evs = time !== undefined ? eventIndexRef.current.get(time) : undefined;
      if (evs && evs.length && param.point) {
        setEventPopup({ x: param.point.x, y: param.point.y, events: evs });
        setFocusedEventId(evs[0].id);
      } else {
        setEventPopup(null);
        setFocusedEventId(null);
      }
    });

    const zonesPrimitive = new ZonesPrimitive();
    candleSeries.attachPrimitive(zonesPrimitive);
    zonesPrimitiveRef.current = zonesPrimitive;

    // Dragging within a dozen bars of the oldest loaded candle pages in
    // more history (no-op while a page is in flight or history is exhausted).
    const onEdgeCheck = (range: LogicalRange | null) => {
      if (range && range.from < 12) loadOlderRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onEdgeCheck);

    const observer = new ResizeObserver((entries) => {
      if (!chartRef.current) return;
      const rect = entries[entries.length - 1].contentRect;
      if (rect.width > 0 && rect.height > 0) {
        chart.applyOptions({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onEdgeCheck);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      supportSeriesRef.current = null;
      resistanceSeriesRef.current = null;
      entrySeriesRef.current = null;
      stopSeriesRef.current = null;
      target1SeriesRef.current = null;
      target2SeriesRef.current = null;
      emaFastSeriesRef.current = null;
      emaSlowSeriesRef.current = null;
      markerRef.current = null;
      zonesPrimitiveRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    try {
      // Symbol/timeframe/source switch: paged-in history belongs to the old dataset.
      const datasetKey = `${symbol}|${timeframe}|${market}|${source}`;
      if (historyRef.current.key !== datasetKey) {
        historyRef.current = {
          key: datasetKey,
          candles: [],
          exhausted: source !== "live",
          loading: false,
        };
      }
      const firstLiveTime = candles[0]?.time;
      const history =
        firstLiveTime === undefined
          ? []
          : historyRef.current.candles.filter((c) => c.time < firstLiveTime);
      // The forming bar is display-only (see `liveCandle`'s doc comment) — it
      // keeps the visible candle in step with the live-anchored plan lines
      // below instead of leaving the chart a full bar behind.
      const allCandles = liveCandle
        ? [...history, ...candles, liveCandle]
        : [...history, ...candles];

      // Filter out invalid candles
      const validCandles = allCandles.filter(
        (c) =>
          c &&
          Number.isFinite(c.time) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          Number.isFinite(c.volume),
      );

      if (validCandles.length === 0) return;

      const lineSeries = [
        supportSeriesRef.current,
        resistanceSeriesRef.current,
        entrySeriesRef.current,
        stopSeriesRef.current,
        target1SeriesRef.current,
        target2SeriesRef.current,
        emaFastSeriesRef.current,
        emaSlowSeriesRef.current,
      ];

      // The default price scale (2dp, 0.01 steps) collapses sub-dollar assets:
      // DOGE's axis becomes a single label and the plan lines overlap. Only
      // re-apply when the precision actually changes (i.e. symbol switch):
      // applyOptions marks every series' cached items for a recolor pass, and
      // that pass crashes on items holding stale time-scale indices.
      const precision = pricePrecision(validCandles.at(-1)?.close ?? 0);
      if (appliedPrecisionRef.current !== precision) {
        appliedPrecisionRef.current = precision;
        const priceFormat = { type: "price" as const, precision, minMove: 10 ** -precision };
        for (const series of [candleSeries, ...lineSeries]) {
          series?.applyOptions({ priceFormat });
        }
      }

      const timeScale = chart.timeScale();
      const isNewDataset = appliedKeyRef.current !== datasetKey;
      const prevRange = timeScale.getVisibleRange();
      const prevLast = lastTimeRef.current;

      // Lightweight-charts bug: when a setData removes time points, the time scale
      // compacts, leaving series set *earlier* with stale index mappings. The
      // chart's pane views defer validation until rendering/hit-test, so errors
      // occur asynchronously during crosshair movement. Workaround: defer visible-
      // range restoration to the next frame, giving the browser one full render
      // cycle to validate all pane views against the final time scale before any
      // user interaction can trigger hit-test (which calls recolor-items code).

      const candleData = validCandles.map(
        (c): CandlestickData<Time> => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }),
      );
      const volumeData = validCandles.map(
        (c): HistogramData<Time> => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? "rgba(34,197,94,0.32)" : "rgba(244,63,94,0.32)",
        }),
      );
      const emaFastData = computeEmaSeries(validCandles, EMA_FAST.length) ?? [];
      const emaSlowData = computeEmaSeries(validCandles, EMA_SLOW.length) ?? [];

      const chartStart = validCandles[0]?.time ?? 0;
      const chartEnd = validCandles.at(-1)?.time ?? Infinity;
      const validSupportData = (trendLines?.support ?? []).filter(
        (p) =>
          p &&
          Number.isFinite(p.time) &&
          Number.isFinite(p.value) &&
          p.time >= chartStart &&
          p.time <= chartEnd,
      );
      const validResistanceData = (trendLines?.resistance ?? []).filter(
        (p) =>
          p &&
          Number.isFinite(p.time) &&
          Number.isFinite(p.value) &&
          p.time >= chartStart &&
          p.time <= chartEnd,
      );

      const start = candles[0]?.time;
      const end = validCandles[validCandles.length - 1]?.time;
      const planActive = plan !== null && plan.direction !== "none";

      // Set all data in one frame
      candleSeries.setData(candleData);
      volumeSeries.setData(volumeData);
      emaFastSeriesRef.current?.setData(toLineData(emaFastData));
      emaSlowSeriesRef.current?.setData(toLineData(emaSlowData));
      supportSeriesRef.current?.setData(toLineData(validSupportData));
      resistanceSeriesRef.current?.setData(toLineData(validResistanceData));

      // Plan levels: entry/stop/targets
      const buildLevelData = (value: number | undefined) => {
        const isValid =
          planActive &&
          start &&
          end &&
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          value !== undefined &&
          Number.isFinite(value);
        return isValid
          ? [
              { time: start as UTCTimestamp, value: value as number },
              { time: end as UTCTimestamp, value: value as number },
            ]
          : [];
      };
      entrySeriesRef.current?.setData(buildLevelData(plan?.entry));
      stopSeriesRef.current?.setData(buildLevelData(plan?.stop));
      target1SeriesRef.current?.setData(buildLevelData(plan?.target1));
      target2SeriesRef.current?.setData(buildLevelData(plan?.target2));

      earliestTimeRef.current = validCandles[0]?.time ?? null;
      lastTimeRef.current = validCandles.at(-1)?.time ?? null;
      appliedKeyRef.current = datasetKey;

      // Defer visible-range restoration through nested requestAnimationFrames to
      // guarantee two full render cycles before user interaction can trigger
      // hit-tests. This ensures all pane views are fully validated against the
      // final time scale before zoom/pan/crosshair events can fire.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (isNewDataset || prevRange === null) {
            timeScale.fitContent();
          } else if (prevLast !== null && (prevRange.to as number) >= prevLast) {
            timeScale.scrollToRealTime();
          } else {
            timeScale.setVisibleRange(prevRange);
          }
        });
      });
      chartRetriesRef.current = 0;
    } catch (err) {
      // Same lightweight-charts bug as above when it escapes the workaround:
      // a stale series/time-scale mapping throws "Value is null" mid-pass,
      // which used to leave the chart partially drawn or blank. Re-run the
      // whole pass on the next frame — the render in between lets the chart
      // rebuild its time scale — bounded so a persistent throw can't loop.
      if (err instanceof Error && err.message.includes("Value is null")) {
        if (chartRetriesRef.current < 3) {
          chartRetriesRef.current += 1;
          requestAnimationFrame(() => setChartRetry((v) => v + 1));
        } else {
          console.warn("TokenChart: lightweight-charts 'Value is null' persisted after retries");
        }
        return;
      }
      throw err;
    }
  }, [
    candles,
    symbol,
    timeframe,
    market,
    source,
    historyVersion,
    trendLines,
    plan,
    liveCandle,
    chartRetry,
  ]);

  useEffect(() => {
    // Markers surface the engine's swing structure directly: the most recent
    // alternation-validated legs, each tagged with its HH/HL/LH/LL label and
    // any break-of-structure event it produced — the same MarketStructure the
    // setup classifier reads, so the chart and the verdict tell one story.
    const swings = evaluation?.structure?.swings ?? [];
    const swingMarkers: SeriesMarker<Time>[] = hiddenIndicators.pivots
      ? []
      : swings
          .slice(-MAX_STRUCTURE_MARKERS)
          .filter((swing) => Number.isFinite(swing.time) && Number.isFinite(swing.price))
          .map((swing) => {
            const tags = [
              swing.label,
              swing.event ? (swing.event === "bos" ? "BOS" : "CHoCH") : null,
              swing.equal ? (swing.equal === "eqh" ? "EQH" : "EQL") : null,
            ].filter((tag): tag is string => tag !== null);
            return {
              time: swing.time as UTCTimestamp,
              position: swing.kind === "high" ? "aboveBar" : "belowBar",
              shape: swing.kind === "high" ? "arrowDown" : "arrowUp",
              color: swing.kind === "high" ? "#f59e0b" : "#22c55e",
              size: 1,
              text: tags.length ? tags.join(" ") : undefined,
            } satisfies SeriesMarker<Time>;
          });
    // Sweep markers ride the liquidity toggle with the pool lines they raid:
    // a circle at the stop-hunt candle, on the side the wick reached into.
    const sweepMarkers: SeriesMarker<Time>[] = hiddenIndicators.liquidity
      ? []
      : (evaluation?.liquiditySweeps ?? [])
          .filter((sweep) => Number.isFinite(sweep.time))
          .map((sweep) => ({
            time: sweep.time as UTCTimestamp,
            position: sweep.side === "bsl" ? "aboveBar" : "belowBar",
            shape: "circle",
            color: sweep.side === "bsl" ? "#c084fc" : "#22d3ee",
            size: 1,
            text: sweep.side === "bsl" ? "BSL sweep" : "SSL sweep",
          }));
    // News + calendar events, plotted on the bar that contains them (upcoming
    // calendar items pin to the latest loaded bar, since they have no future
    // bar to sit on). One marker per bar per family — a bar's events collapse
    // into a single "Kind +N" chip whose colour is the most-alerting tone
    // present. eventIndexRef lets a chart click resolve the bar to its events.
    const eventIndex = new Map<number, ChartEvent[]>();
    let eventMarkers: SeriesMarker<Time>[] = [];
    if (!hiddenIndicators.events && events.length > 0 && candles.length > 0) {
      const candleTimes = candles.map((c) => c.time as number);
      const byBar = new Map<
        string,
        { barTime: number; when: ChartEvent["when"]; events: ChartEvent[] }
      >();
      for (const ev of events) {
        const barTime = snapToCandle(candleTimes, ev.timeSec);
        if (barTime === null) continue; // predates loaded history — strip carries it
        const key = `${barTime}:${ev.when}`;
        const bucket = byBar.get(key) ?? { barTime, when: ev.when, events: [] };
        bucket.events.push(ev);
        byBar.set(key, bucket);
        const atBar = eventIndex.get(barTime) ?? [];
        atBar.push(ev);
        eventIndex.set(barTime, atBar);
      }
      eventMarkers = [...byBar.values()].map(({ barTime, when, events: bucket }) => {
        const tone = bucket.some((e) => e.tone === "bearish")
          ? "bearish"
          : bucket.some((e) => e.tone === "bullish")
            ? "bullish"
            : "neutral";
        const extra = bucket.length > 1 ? ` +${bucket.length - 1}` : "";
        return {
          time: barTime as UTCTimestamp,
          position: when === "upcoming" ? "aboveBar" : "belowBar",
          shape: when === "upcoming" ? "square" : "circle",
          color: TONE_HEX[tone],
          size: 1,
          text: `${when === "upcoming" ? "⧗ " : ""}${kindLabel(bucket[0].kind)}${extra}`,
        } satisfies SeriesMarker<Time>;
      });
    }
    eventIndexRef.current = eventIndex;

    // setMarkers replaces the whole set, and lightweight-charts requires
    // ascending time — merge every family before handing them over.
    const markers = [...swingMarkers, ...sweepMarkers, ...eventMarkers].sort(
      (a, b) => (a.time as number) - (b.time as number),
    );
    markerRef.current?.setMarkers(markers);
  }, [
    evaluation,
    hiddenIndicators.pivots,
    hiddenIndicators.liquidity,
    hiddenIndicators.events,
    events,
    candles,
  ]);

  useEffect(() => {
    emaFastSeriesRef.current?.applyOptions({ visible: !hiddenIndicators.emaFast });
    emaSlowSeriesRef.current?.applyOptions({ visible: !hiddenIndicators.emaSlow });
    supportSeriesRef.current?.applyOptions({ visible: !hiddenIndicators.support });
    resistanceSeriesRef.current?.applyOptions({ visible: !hiddenIndicators.resistance });
    volumeSeriesRef.current?.applyOptions({ visible: !hiddenIndicators.volume });
    for (const series of [
      entrySeriesRef.current,
      stopSeriesRef.current,
      target1SeriesRef.current,
      target2SeriesRef.current,
    ]) {
      series?.applyOptions({ visible: !hiddenIndicators.plan });
    }
  }, [hiddenIndicators]);

  useEffect(() => {
    // Demand/supply bases first so the trade-plan bands paint on top of them.
    const zones: PriceZone[] = [];
    if (!hiddenIndicators.sdZones) {
      zones.push(...baseZonesToPriceZones(baseZones));
      zones.push(...poiOverlaysToPriceZones(obFvgPois));
    }
    if (!hiddenIndicators.zones) zones.push(...computeSetupZones(candles, plan, planStrong));
    zonesPrimitiveRef.current?.setZones(zones);
  }, [
    candles,
    plan,
    planStrong,
    baseZones,
    obFvgPois,
    hiddenIndicators.zones,
    hiddenIndicators.sdZones,
  ]);

  // Intact liquidity pools drawn as labeled horizontal price lines: purple
  // buy-side (BSL) lines at equal-high clusters, cyan sell-side (SSL) at
  // equal-low clusters, each titled with its confidence. Spent pools
  // (intact: false) are engine history, not chart furniture — skipped.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || hiddenIndicators.liquidity) return;

    const lines: IPriceLine[] = [];
    // A swept pool's stops are gone even when swing bookkeeping still calls it
    // intact (the raid wick may never confirm as a pivot) — don't draw it.
    const sweptPools = new Set((evaluation?.liquiditySweeps ?? []).map((sweep) => sweep.pool));
    for (const pool of evaluation?.liquidity ?? []) {
      if (!pool.intact || sweptPools.has(pool) || !Number.isFinite(pool.price)) continue;
      lines.push(
        series.createPriceLine({
          price: pool.price,
          color: pool.side === "bsl" ? "#c084fc" : "#22d3ee",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${pool.side === "bsl" ? "BSL" : "SSL"} ${pool.tier}`,
        }),
      );
    }

    // Same teardown discipline as the session-level lines below: remove only
    // from this effect's series, and tolerate a chart already disposed.
    return () => {
      if (!chartRef.current || !candleSeriesRef.current) return;
      for (const line of lines) {
        try {
          series.removePriceLine(line);
        } catch {
          /* series already disposed by chart teardown */
        }
      }
    };
  }, [evaluation, hiddenIndicators.liquidity]);

  // Session high/low levels drawn as labeled horizontal price lines. Rebuilt
  // whenever the levels, timeframe, or visibility toggle change; skipped on
  // higher timeframes where they'd sit far off-screen.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || hiddenIndicators.sessions || !SESSION_LINE_TIMEFRAMES.includes(timeframe)) {
      return;
    }

    const lines: IPriceLine[] = [];
    for (const level of sessionLevels) {
      const color = SESSION_LINE_COLORS[level.session] ?? "#94a3b8";
      const add = (price: number, suffix: string) => {
        // A non-finite price would make lightweight-charts throw "Value is
        // null" on its next repaint — never hand it one.
        if (!Number.isFinite(price)) return;
        lines.push(
          series.createPriceLine({
            price,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: `${level.label} ${suffix}`,
          }),
        );
      };
      add(level.high, "H");
      add(level.low, "L");
    }

    // Remove on the next re-run and on unmount, scoped to THIS effect's series
    // so we never hand one series a price line created on another (a disposed
    // series' line → lightweight-charts "Value is null" on repaint). Guard the
    // teardown in case the chart was already removed first.
    return () => {
      if (!chartRef.current || !candleSeriesRef.current) return;
      for (const line of lines) {
        try {
          series.removePriceLine(line);
        } catch {
          /* series already disposed by chart teardown */
        }
      }
    };
  }, [sessionLevels, timeframe, hiddenIndicators.sessions]);

  return (
    <>
      <div className="relative min-h-0 flex-1">
        {loadingHistory && (
          <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
            <span className="h-3 w-3 animate-spin rounded-full border border-info border-t-transparent" />
            Loading older bars…
          </div>
        )}
        <div
          ref={hostRef}
          className={cn("w-full", fillHeight ? "h-full" : "h-[360px] sm:h-[400px] lg:h-full")}
        />
        <TradeActionOverlay
          chart={chartRef.current}
          series={candleSeriesRef.current}
          plan={plan}
          planStrong={planStrong}
          onTrade={() => onTrade?.()}
        />
        {eventPopup && !hiddenIndicators.events && (
          <ChartEventPopup
            events={eventPopup.events}
            x={eventPopup.x}
            y={eventPopup.y}
            onClose={() => {
              setEventPopup(null);
              setFocusedEventId(null);
            }}
          />
        )}
      </div>
      {!hiddenIndicators.events && (
        <ChartEventStrip
          events={events}
          activeId={focusedEventId}
          onFocus={(ev) => setFocusedEventId(ev.id)}
        />
      )}
      <ChartLegend
        hidden={hiddenIndicators}
        planActive={plan !== null && plan.direction !== "none"}
        zonesActive={planStrong && plan !== null && plan.direction !== "none"}
        planTimeframe={planTimeframe}
        sdActive={baseZones.length > 0 || obFvgPois.length > 0}
        sessionsActive={sessionLevels.length > 0 && SESSION_LINE_TIMEFRAMES.includes(timeframe)}
        onToggle={toggleIndicator}
      />
    </>
  );
}

// Zones paint only when the verdict actually wants the trade (favored or
// caution — `planStrong`), not when the assistant merely leans a direction
// while telling you to wait. The plan is the intent's execution-TF plan.
function computeSetupZones(
  candles: TokenSignalData["candles"],
  risk: RiskRewardPlan | null,
  strong: boolean,
): PriceZone[] {
  if (!risk || !strong || risk.direction === "none") return [];
  const planStart = candles[Math.max(0, candles.length - 10)]?.time;
  if (planStart === undefined) return [];

  const long = risk.direction === "long";
  const zones: PriceZone[] = [];

  // Green-red position bands: reward up to targets, risk down to the stop.
  zones.push({
    priceLow: Math.min(risk.entry, risk.target1),
    priceHigh: Math.max(risk.entry, risk.target1),
    from: planStart as UTCTimestamp,
    fill: "rgba(34,197,94,0.10)",
    border: "rgba(34,197,94,0.28)",
    label: `TP1 ${risk.target1 < 10 ? risk.target1.toPrecision(5) : risk.target1.toFixed(2)} (${risk.rewardRisk1.toFixed(2)}R)`,
    labelColor: "rgba(34,197,94,0.85)",
    labelAlign: long ? "top" : "bottom",
  });

  if (risk.target2 && risk.target2 !== risk.target1) {
    zones.push({
      priceLow: Math.min(risk.target1, risk.target2),
      priceHigh: Math.max(risk.target1, risk.target2),
      from: planStart as UTCTimestamp,
      fill: "rgba(34,197,94,0.05)",
      border: "rgba(34,197,94,0.15)",
      label: `TP2 ${risk.target2 < 10 ? risk.target2.toPrecision(5) : risk.target2.toFixed(2)} (${risk.rewardRisk2.toFixed(2)}R)`,
      labelColor: "rgba(34,197,94,0.70)",
      labelAlign: long ? "top" : "bottom",
    });
  }

  zones.push({
    priceLow: Math.min(risk.entry, risk.stop),
    priceHigh: Math.max(risk.entry, risk.stop),
    from: planStart as UTCTimestamp,
    fill: "rgba(244,63,94,0.10)",
    border: "rgba(244,63,94,0.28)",
    label: `SL ${risk.stop < 10 ? risk.stop.toPrecision(5) : risk.stop.toFixed(2)} (1R)`,
    labelColor: "rgba(244,63,94,0.85)",
    labelAlign: long ? "bottom" : "top",
  });

  // Ideal entry zone, straight from the engine's risk plan.
  zones.push({
    priceLow: risk.entryLow,
    priceHigh: risk.entryHigh,
    from: planStart as UTCTimestamp,
    fill: "rgba(96,165,250,0.14)",
    border: "rgba(96,165,250,0.40)",
    label: long ? "BUY ZONE" : "SELL ZONE",
    labelColor: "rgba(96,165,250,0.95)",
    labelAlign: "middle",
  });

  return zones;
}

// Detected accumulation/distribution bases. Fresh (untested) zones paint
// stronger than ones already retested once.
function baseZonesToPriceZones(zones: BaseZone[]): PriceZone[] {
  return zones.map((zone) => {
    const demand = zone.kind === "demand";
    const fresh = zone.freshness === "fresh";
    const rgb = demand ? "34,197,94" : "245,158,11";
    return {
      priceLow: zone.priceLow,
      priceHigh: zone.priceHigh,
      from: zone.startTime as UTCTimestamp,
      fill: `rgba(${rgb},${fresh ? 0.1 : 0.06})`,
      border: `rgba(${rgb},${fresh ? 0.3 : 0.16})`,
      label: `${demand ? "DEMAND" : "SUPPLY"}${fresh ? "" : " · TESTED"}`,
      labelColor: `rgba(${rgb},${fresh ? 0.85 : 0.55})`,
      labelAlign: demand ? "top" : "bottom",
    };
  });
}

// Order-block and FVG/iFVG bands from the unified POI map (EDR 0014) — indigo
// for OBs, teal for the FVG family, so neither collides with the green/amber
// base-zone family or the purple/cyan liquidity lines. Fainter than base
// zones: these are secondary reads until the POI cutover gate. Terminal
// states (invalidated/consumed) stay on the ledger card but are not chart
// furniture (EDR 0015).
function poiOverlaysToPriceZones(pois: UnifiedPoi[]): PriceZone[] {
  return pois
    .filter((poi) => !TERMINAL_POI_STATES.includes(poi.state))
    .map((poi) => {
      const ob = poi.source === "order-block";
      const fresh = poi.state === "fresh";
      const rgb = ob ? "129,140,248" : "45,212,191";
      const source = ob ? "OB" : poi.source === "ifvg" ? "iFVG" : "FVG";
      const suffix = fresh ? "" : ` · ${poi.state.toUpperCase()}`;
      const label = `${source} ${poi.kind === "demand" ? "DEMAND" : "SUPPLY"}${suffix}`;
      return {
        priceLow: poi.priceLow,
        priceHigh: poi.priceHigh,
        from: poi.startTime as UTCTimestamp,
        fill: `rgba(${rgb},${fresh ? 0.07 : 0.04})`,
        border: `rgba(${rgb},${fresh ? 0.24 : 0.12})`,
        label,
        labelColor: `rgba(${rgb},${fresh ? 0.8 : 0.5})`,
        labelAlign: poi.kind === "demand" ? ("top" as const) : ("bottom" as const),
      };
    });
}

function toLineData(points: Array<{ time: number; value: number }>): LineData<Time>[] {
  return (points || [])
    .filter((point) => point && Number.isFinite(point.time) && Number.isFinite(point.value))
    .map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
}

function lineSwatch(color: string, dashed = false) {
  return (
    <span
      className="h-[2px] w-3.5 shrink-0 rounded-full"
      style={
        dashed
          ? {
              backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 5px)`,
            }
          : { backgroundColor: color }
      }
    />
  );
}

const LEGEND_ENTRIES: Array<{ key: IndicatorKey; label: string; hint: string; swatch: ReactNode }> =
  [
    {
      key: "volume",
      label: "Volume",
      hint: "Traded volume per bar along the bottom — green when the candle closed up, red when it closed down. Rising volume confirms a move; falling volume questions it.",
      swatch: (
        <span className="flex shrink-0 items-end gap-px">
          <span className="h-1.5 w-[3px] rounded-[1px] bg-[#22c55e]/40" />
          <span className="h-2.5 w-[3px] rounded-[1px] bg-[#f43f5e]/40" />
          <span className="h-2 w-[3px] rounded-[1px] bg-[#22c55e]/40" />
        </span>
      ),
    },
    {
      key: "emaFast",
      label: `EMA ${EMA_FAST.length}`,
      hint: "Exponential moving average of the last 13 closes — the fast momentum curve. Price above it with EMA 13 on top of EMA 21 favors buyers.",
      swatch: lineSwatch(EMA_FAST.color),
    },
    {
      key: "emaSlow",
      label: `EMA ${EMA_SLOW.length}`,
      hint: "Exponential moving average of the last 21 closes — the slower trend curve the fast EMA is measured against.",
      swatch: lineSwatch(EMA_SLOW.color),
    },
    {
      key: "support",
      label: "Support",
      hint: "Dashed green trend line through recent swing lows — the floor buyers have been defending.",
      swatch: lineSwatch("#22c55e", true),
    },
    {
      key: "resistance",
      label: "Resistance",
      hint: "Dashed amber trend line through recent swing highs — the ceiling sellers have been defending.",
      swatch: lineSwatch("#f59e0b", true),
    },
    {
      key: "pivots",
      label: "Swing structure",
      hint: "Arrows mark the confirmed swing legs (amber ▼ highs, green ▲ lows), each labeled against the prior swing of its kind: HH/HL = higher high/low, LH/LL = lower high/low. BOS tags a break that extends the trend; CHoCH a break against it — the first structural hint of a reversal. EQH/EQL mark equal highs/lows — matching swing levels where stop-loss liquidity tends to rest. Trend lines and setups are built from these.",
      swatch: (
        <span className="flex shrink-0 items-center gap-0.5 text-[8px] leading-none">
          <span className="text-[#f59e0b]">▼</span>
          <span className="text-[#22c55e]">▲</span>
        </span>
      ),
    },
    {
      key: "liquidity",
      label: "Liquidity",
      hint: "Dashed horizontal lines at intact liquidity pools: purple BSL (buy-side) at equal highs — stop orders resting above a double/triple top — and cyan SSL (sell-side) at equal lows. The label is the pool's strength tier — Strong/Moderate/Weak, from touches, tightness, and freshness — an ordinal ranking, not a probability. Price is often drawn toward these levels before reversing. Circles mark liquidity sweeps: a wick ran the pool's stops but the candle closed back inside — a stop hunt, and often the start of the move the raid funded.",
      swatch: (
        <span className="flex shrink-0 flex-col gap-[2px]">
          <span className="h-[2px] w-3.5 rounded-full bg-[#c084fc]" />
          <span className="h-[2px] w-3.5 rounded-full bg-[#22d3ee]" />
        </span>
      ),
    },
    {
      key: "plan",
      label: "Trade plan",
      hint: "Your objective's plan levels: entry (blue), stop (rose), target 1 (solid green), target 2 (dashed green). These come from the objective's trigger timeframe (named on the label) and stay the same while you explore other chart timeframes — one trade story per page. Shown only while the objective has a directional plan.",
      swatch: (
        <span className="flex shrink-0 flex-col gap-[2px]">
          <span className="h-[2px] w-3.5 rounded-full bg-[#60a5fa]" />
          <span className="h-[2px] w-3.5 rounded-full bg-[#f43f5e]" />
          <span className="h-[2px] w-3.5 rounded-full bg-[#22c55e]" />
        </span>
      ),
    },
    {
      key: "zones",
      label: "Trade zones",
      hint: "Shaded bands drawn only while your objective's verdict wants the trade: green = reward to target 1, red = risk to the stop, blue = the buy/sell pocket around entry. Like the trade plan, they belong to the objective's trigger timeframe (named on the label), whatever timeframe the chart shows.",
      swatch: (
        <span className="flex shrink-0 flex-col">
          <span className="h-1.5 w-3.5 rounded-t-[2px] bg-[#22c55e]/30" />
          <span className="h-1.5 w-3.5 rounded-b-[2px] bg-[#f43f5e]/30" />
        </span>
      ),
    },
    {
      key: "sdZones",
      label: "Demand/Supply",
      hint: "True demand/supply bases: a tight consolidation followed by an explosive move away. Green = demand (buyers launched from here), amber = supply (sellers did). Bright = fresh and untested; faded = already retested once. Zones price closed through are dropped. Detected on 1H, 4H, 1D and 1W charts, where bases are meaningful.",
      swatch: (
        <span className="flex shrink-0 flex-col gap-[2px]">
          <span className="h-1 w-3.5 rounded-[1px] border border-[#f59e0b]/40 bg-[#f59e0b]/15" />
          <span className="h-1 w-3.5 rounded-[1px] border border-[#22c55e]/40 bg-[#22c55e]/15" />
        </span>
      ),
    },
    {
      key: "sessions",
      label: "Session H/L",
      hint: "The high and low of the most recent completed Asia (pink), London (teal) and New York (orange) session, drawn as dotted levels. Yesterday's session extremes are the intraday levels traders lean on. Shown on 15M–4H charts, where they're in range.",
      swatch: (
        <span className="flex shrink-0 flex-col gap-[2px]">
          <span className="h-[2px] w-3.5 rounded-full bg-[#f472b6]" />
          <span className="h-[2px] w-3.5 rounded-full bg-[#2dd4bf]" />
          <span className="h-[2px] w-3.5 rounded-full bg-[#fb923c]" />
        </span>
      ),
    },
    {
      key: "events",
      label: "News & events",
      hint: "Token news (past) and calendar catalysts (upcoming, ⧗) plotted on the bar they land on — coloured red/grey/green by likely impact (security, delisting, regulatory and unlocks read red; listings and upgrades green). Circles below a bar are past news; squares above the last bar are scheduled events. Click a marker for details and its source, or use the strip under the chart.",
      swatch: (
        <span className="flex shrink-0 items-center gap-0.5">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TONE_HEX.bearish }}
          />
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TONE_HEX.neutral }}
          />
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TONE_HEX.bullish }}
          />
        </span>
      ),
    },
  ];

function ChartLegend({
  hidden,
  planActive,
  zonesActive,
  planTimeframe,
  sdActive,
  sessionsActive,
  onToggle,
}: {
  hidden: Partial<Record<IndicatorKey, boolean>>;
  planActive: boolean;
  zonesActive: boolean;
  /** The plan's source timeframe, shown on the plan/zones labels ("Trade plan · 4H"). */
  planTimeframe: TokenTimeframe | null;
  sdActive: boolean;
  sessionsActive: boolean;
  onToggle: (key: IndicatorKey) => void;
}) {
  return (
    // One scrollable row on phones (wrapping would stack three rows of chips
    // between the user and the chart); wraps as before from sm up.
    <div className="flex shrink-0 items-center gap-x-1 gap-y-0.5 overflow-x-auto border-t border-border px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-x-visible">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            <span className="flex shrink-0 items-end gap-0.5">
              <span className="h-2.5 w-1 rounded-[1px] bg-[#22c55e]" />
              <span className="h-2 w-1 rounded-[1px] bg-[#f43f5e]" />
            </span>
            Candles
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[240px] bg-popover text-xs leading-relaxed text-popover-foreground shadow-lg"
        >
          One bar of price movement — green closed up, red closed down. The wicks show the high and
          low reached within the bar.
        </TooltipContent>
      </Tooltip>
      {LEGEND_ENTRIES.map((entry) => {
        if (entry.key === "plan" && !planActive) return null;
        if (entry.key === "zones" && !zonesActive) return null;
        if (entry.key === "sdZones" && !sdActive) return null;
        if (entry.key === "sessions" && !sessionsActive) return null;
        const isHidden = hidden[entry.key] === true;
        // The plan overlays are pinned to the objective's trigger timeframe —
        // name it on the label so a 15M chart never implies a 15M plan.
        const label =
          (entry.key === "plan" || entry.key === "zones") && planTimeframe
            ? `${entry.label} · ${planTimeframe}`
            : entry.label;
        return (
          <Tooltip key={entry.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onToggle(entry.key)}
                aria-pressed={!isHidden}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-surface",
                  isHidden ? "opacity-40 grayscale" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {entry.swatch}
                <span className={cn(isHidden && "line-through")}>{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[240px] bg-popover text-xs leading-relaxed text-popover-foreground shadow-lg"
            >
              {entry.hint} Click to {isHidden ? "show" : "hide"}.
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Chart price-scale decimals for a given price magnitude. */
function pricePrecision(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 100 || abs === 0) return 2;
  if (abs >= 1) return 3;
  if (abs >= 0.01) return 5;
  return Math.min(10, -Math.floor(Math.log10(abs)) + 3);
}

function computeChange24h(candles: TokenSignalData["candles"]): number {
  const lastCandle = candles.at(-1);
  if (!lastCandle) return 0;

  const targetTime = lastCandle.time - 24 * 60 * 60;
  let base = candles[0];
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time <= targetTime) {
      base = candles[i];
      break;
    }
  }
  if (!base || base.close === 0) return 0;

  return Number((((lastCandle.close - base.close) / base.close) * 100).toFixed(2));
}

function AssistantPanel({
  symbol,
  assessments,
  active,
  activeIntent,
  marketOutlook,
  structuresByTimeframe,
  perp,
  sessionLevels,
  price,
  liveData,
  poiMap,
  poiTimeframe,
  setupValidity,
  onSelect,
  activeTab,
  onTabChange,
  onOpenTrade,
  className,
}: {
  symbol: string;
  assessments: DisplayIntentAssessment[];
  active: DisplayIntentAssessment | null;
  activeIntent: TradingIntent;
  marketOutlook: string;
  structuresByTimeframe: Partial<Record<TokenTimeframe, MarketStructure>>;
  perp: PerpRead | null;
  sessionLevels: SessionLevel[];
  price: number;
  /** Whether the candles are real Binance data — the anticipatory read renders only on live data. */
  liveData: boolean;
  /** Unified POI ledger for the visible chart timeframe (display-only, EDR 0014). */
  poiMap: UnifiedPoi[];
  poiTimeframe: TokenTimeframe;
  /** Whether the plan is still valid at the live price (null when no plan). */
  setupValidity: SetupValidityResult | null;
  onSelect: (intent: TradingIntent) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
  /** Opens the trade drawer (constitution-gated permit → confirm), prefilled from this plan. */
  onOpenTrade: () => void;
  className?: string;
}) {
  const byIntent = new Map(assessments.map((a) => [a.intent, a]));
  const router = useRouter();
  const followSignal = useFollowSignal();
  const { follows } = useTrackedFollows();
  const hasOpenSignal = (sym: string, intent: TradingIntent, direction: string) =>
    follows.some(
      (s) =>
        s.symbol === sym &&
        s.intent === intent &&
        s.direction === direction &&
        s.status === "active",
    );
  const marketType = usePreferencesStore((s) => s.marketType);
  const leverage = usePreferencesStore((s) => s.leverage);
  const setLeverage = usePreferencesStore((s) => s.setLeverage);
  const [followDialogOpen, setFollowDialogOpen] = useState(false);
  const [entryPriceInput, setEntryPriceInput] = useState("");

  const openFollowDialog = () => {
    if (!active?.plan) return;
    setEntryPriceInput(String(active.plan.entry));
    setFollowDialogOpen(true);
  };

  const confirmFollow = async () => {
    if (!active?.plan || active.direction === "none") return;
    // Safety re-check: the setup may have invalidated while the dialog was open.
    if (setupValidity && !setupValidity.valid) {
      toast.error(setupValidity.reason ?? "This setup is no longer valid.");
      setFollowDialogOpen(false);
      return;
    }
    const entryPrice = Number.parseFloat(entryPriceInput);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      toast.error("Enter a valid entry price.");
      return;
    }
    try {
      await followSignal.mutateAsync({
        symbol,
        intent: active.intent,
        direction: active.direction,
        setupType: active.execution.setupType,
        timeframe: active.definition.executionTimeframe,
        market: marketType,
        entryLow: active.plan.entryLow,
        entryHigh: active.plan.entryHigh,
        entryPrice,
        stop: active.plan.stop,
        target1: active.plan.target1,
        target2: active.plan.target2,
        confidenceAtFollow: active.confidence,
      });
    } catch (error) {
      if (error instanceof NotSignedInError) {
        toast.error("Sign in to follow signals — follows live in your server record now.", {
          action: { label: "Sign in", onClick: () => router.navigate({ to: "/login" }) },
        });
      } else {
        toast.error("Couldn't save the follow — check your connection and try again.");
      }
      return;
    }
    setFollowDialogOpen(false);
    toast(`Now tracking ${symbol}`, {
      description: `${active.definition.label} ${active.direction} signal added to the tracker at ${formatMoney(entryPrice)}.`,
      action: {
        label: "View",
        onClick: () => router.navigate({ to: "/tracker" }),
      },
    });
  };

  return (
    <IqCard padded={false} className={cn("flex min-h-0 flex-col p-0", className)}>
      <div className="shrink-0 space-y-2.5 border-b border-border p-3">
        <div className="flex items-center gap-1.5">
          <CardEyebrow>Decision Assistant</CardEyebrow>
          <InfoHint text="One chart, many valid answers. Pick your objective and the assistant tells you whether this market pays it right now, what confirmation is still missing, and which price events would change today's answer." />
        </div>
        <div
          data-tour="objective"
          className="grid grid-cols-4 rounded-md border border-border bg-surface p-0.5 text-xs"
        >
          {INTENTS.map((def) => {
            const a = byIntent.get(def.intent);
            return (
              <button
                key={def.intent}
                type="button"
                onClick={() => onSelect(def.intent)}
                title={a?.headline ?? `${def.label}: assessing…`}
                className={cn(
                  "flex h-10 flex-col items-center justify-center gap-1 rounded px-1 font-semibold transition-colors",
                  activeIntent === def.intent
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <VerdictDot assessment={a} />
                {def.label}
              </button>
            );
          })}
        </div>
      </div>

      {!active ? (
        <div className="space-y-3 p-3">
          <div className="h-28 animate-pulse rounded-lg bg-surface" />
          <div className="h-40 animate-pulse rounded-lg bg-surface" />
          <div className="h-28 animate-pulse rounded-lg bg-surface" />
        </div>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={onTabChange}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="flex h-auto w-full shrink-0 justify-start gap-0.5 overflow-x-auto rounded-none border-b border-border bg-transparent p-1.5">
            {(
              [
                ["overview", "Overview"],
                ["why", "Why"],
                ["plan", "Plan"],
                ["evidence", "Evidence"],
                ["details", "Details"],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger key={value} value={value} className="shrink-0 px-2.5 py-1 text-[11px]">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {/* 1 — OVERVIEW: decide in seconds. Verdict, edge, plan, one status
                line — no prose. The reasoning lives on the Why tab. */}
            <TabsContent value="overview" className="mt-0 space-y-2">
              <div
                data-tour="decision"
                className={cn("rounded-lg border p-3", verdictTone(active))}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <VerdictHero assessment={active} />
                    <p className="mt-1.5 truncate text-xs font-semibold text-foreground">
                      {active.direction !== "none"
                        ? humanSetup(active.execution.setupType)
                        : active.headline}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {`${active.definition.contextTimeframe} context · ${active.definition.executionTimeframe} trigger · holds ${active.definition.horizon}`}
                    </p>
                  </div>
                  <ReadStrengthGauge assessment={active} />
                </div>
              </div>

              <EdgeStats assessment={active} />

              {active.plan && (
                <>
                  <div className="flex gap-1.5">
                    <div className="min-w-0 flex-1 space-y-1">
                      <PlanRow
                        color="#60a5fa"
                        label="Entry"
                        value={formatEntryRange(active.plan.entryLow, active.plan.entryHigh)}
                      />
                      <PlanRow
                        color="#f43f5e"
                        label="Stop loss"
                        value={formatMoney(active.plan.stop)}
                      />
                      <PlanRow
                        color="#22c55e"
                        label="Target 1"
                        value={formatMoney(active.plan.target1)}
                      />
                      <PlanRow
                        color="#22c55e"
                        label="Target 2"
                        value={formatMoney(active.plan.target2)}
                      />
                      <PlanRow
                        color="#94a3b8"
                        label="R / R"
                        value={`${active.plan.rewardRisk1}R / ${active.plan.rewardRisk2}R`}
                      />
                    </div>
                    <PlanLadder plan={active.plan} />
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <RiskMetric
                      label="Position"
                      value={formatMoney(active.plan.positionSize * active.plan.entry)}
                      compact
                    />
                    <RiskMetric
                      label="Max loss"
                      value={formatMoney(active.plan.maxDollarLoss)}
                      tone="bearish"
                      compact
                    />
                    <RiskMetric
                      label="Gain @ T1"
                      value={formatMoney(active.plan.estimatedGain1)}
                      tone="bullish"
                      compact
                    />
                  </div>
                </>
              )}

              <DecisionBanner active={active} assessments={assessments} />
            </TabsContent>

            {/* 2 — WHY: the reasoning behind the verdict, in full. */}
            <TabsContent value="why" className="mt-0 space-y-3">
              <div className={cn("rounded-lg border p-2.5", verdictTone(active))}>
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Verdict · {active.definition.label}</CardEyebrow>
                  <InfoHint text="'Not yet', 'reduced size', 'wrong direction', and 'unsuitable market' are all different answers. The Overview names the one that applies; this text explains why in plain words." />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {active.summary}
                </p>
                <HoldNote hold={active.hold} />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>
                    Checklist · {active.checklist.filter((item) => item.done).length}/
                    {active.checklist.length}
                  </CardEyebrow>
                  <InfoHint text="Everything this objective needs before a full-size entry. The unchecked items are what 'not yet' means, concretely. Hover an item for the detail." />
                </div>
                <div className="space-y-1">
                  {active.checklist.map((item) => (
                    <Tooltip key={item.label}>
                      <TooltipTrigger asChild>
                        <div className="flex cursor-default items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
                          {item.done ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-bullish" />
                          ) : (
                            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
                          )}
                          <span className="min-w-0 truncate text-[11px] font-semibold">
                            {item.label}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        className="max-w-[260px] bg-popover text-xs leading-relaxed text-popover-foreground shadow-lg"
                      >
                        {item.detail}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>What Changes This Answer</CardEyebrow>
                  <InfoHint text="Concrete price events that would upgrade, downgrade, or flip today's verdict — so you know what to watch for instead of re-reading the chart all day." />
                </div>
                <div className="space-y-1">
                  {active.triggers.map((trigger) => (
                    <div
                      key={trigger}
                      className="flex items-start gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
                    >
                      <Zap className="mt-0.5 h-3 w-3 shrink-0 text-info" />
                      <span>{trigger}</span>
                    </div>
                  ))}
                </div>
              </div>

              {marketOutlook && (
                <div className="rounded-lg border border-border bg-surface p-2.5">
                  <div className="flex items-center gap-1.5">
                    <CardEyebrow>Market Outlook</CardEyebrow>
                    <InfoHint text="The current market story for this token, told before any recommendation: the big picture, the near-term tape, and what that combination rewards. Every verdict is this narrative applied to one objective." />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    {marketOutlook}
                  </p>
                </div>
              )}
            </TabsContent>

            {/* 2 — PLAN: the execution plan, sizing, and entry location. */}
            <TabsContent value="plan" className="mt-0 space-y-3">
              <div data-tour="risk" className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <CardEyebrow>
                      Execution Plan · {active.definition.executionTimeframe}
                    </CardEyebrow>
                    <InfoHint text="A complete plan for your objective, sized to your account: entry, stop, two targets, position size, and worst-case loss. Counter-trend verdicts are automatically halved. Change account size and risk in Settings." />
                  </div>
                  {active.plan && active.sizeMultiplier < 1 && (
                    <Badge
                      variant="outline"
                      className="border-warning/30 bg-warning-soft text-warning"
                    >
                      ½ size
                    </Badge>
                  )}
                </div>
                {active.plan ? (
                  <>
                    <div className="grid grid-cols-2 gap-1.5">
                      <RiskMetric
                        label="Entry zone"
                        value={formatEntryRange(active.plan.entryLow, active.plan.entryHigh)}
                        compact
                      />
                      <RiskMetric
                        label="Stop"
                        value={formatMoney(active.plan.stop)}
                        tone="bearish"
                        compact
                      />
                      <RiskMetric
                        label="Target 1"
                        value={formatMoney(active.plan.target1)}
                        tone="bullish"
                        compact
                      />
                      <RiskMetric
                        label="Target 2"
                        value={formatMoney(active.plan.target2)}
                        tone="bullish"
                        compact
                      />
                      <RiskMetric
                        label="Position"
                        value={`${formatUnits(active.plan.positionSize)} ≈ ${formatMoney(active.plan.positionSize * active.plan.entry)}`}
                        compact
                      />
                      <RiskMetric
                        label="R/R"
                        value={`${active.plan.rewardRisk1}R / ${active.plan.rewardRisk2}R`}
                        compact
                      />
                      <RiskMetric
                        label="Max loss"
                        value={formatMoney(active.plan.maxDollarLoss)}
                        tone="bearish"
                        compact
                      />
                      <RiskMetric
                        label="Gain @ T1 / T2"
                        value={`${formatMoney(active.plan.estimatedGain1)} / ${formatMoney(active.plan.estimatedGain2)}`}
                        tone="bullish"
                        compact
                      />
                    </div>
                    {marketType === "perp" && (
                      <>
                        <PerpLeverage
                          plan={active.plan}
                          leverage={leverage}
                          onLeverage={setLeverage}
                        />
                        <LiquidationCheck plan={active.plan} leverage={leverage} />
                      </>
                    )}
                    <SizingNote multiplier={active.sizeMultiplier} />
                    {setupValidity && !setupValidity.valid ? (
                      <div className="flex w-full items-center gap-1.5 rounded-md border border-warning/30 bg-warning-soft px-2.5 py-2 text-xs text-warning">
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          {setupValidity.reason ?? "Setup no longer valid at current price."}
                        </span>
                      </div>
                    ) : (
                      (active.verdict === "favored" || active.verdict === "caution") &&
                      active.direction !== "none" && (
                        // The plan and the action are one unit: placing a
                        // trade is the primary path out of this tab, prefilled
                        // straight from the plan above (see tradeTicketDefaults
                        // + executionLogContext); "Follow" is the separate,
                        // secondary paper-tracking bookmark.
                        <div className="flex flex-col gap-1.5">
                          <Button
                            size="sm"
                            className="w-full gap-1.5 text-xs font-semibold"
                            onClick={onOpenTrade}
                          >
                            <Send className="h-3.5 w-3.5" />
                            Place Trade — Get Permit
                          </Button>
                          {hasOpenSignal(symbol, active.intent, active.direction) ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled
                              className="w-full gap-1.5 text-xs"
                            >
                              <BookmarkCheck className="h-3.5 w-3.5" />
                              Following this signal
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full gap-1.5 text-xs"
                              onClick={openFollowDialog}
                            >
                              <Bookmark className="h-3.5 w-3.5" />
                              Follow this signal
                            </Button>
                          )}
                        </div>
                      )
                    )}
                  </>
                ) : (
                  <p className="rounded-lg border border-border bg-surface p-2.5 text-xs leading-relaxed text-muted-foreground">
                    {planEmptyMessage(active, assessments)}
                  </p>
                )}
              </div>

              {liveData && active.anticipatoryPlan && (
                <AnticipatoryReadCard
                  plan={active.anticipatoryPlan}
                  timeframe={active.definition.executionTimeframe}
                />
              )}

              {liveData && poiMap.length > 0 && (
                <PoiMapCard pois={poiMap} timeframe={poiTimeframe} />
              )}

              {active.location && (
                <LocationRow
                  location={active.location}
                  support={active.execution.analytics.support}
                  resistance={active.execution.analytics.resistance}
                />
              )}

              {sessionLevels.length > 0 && price > 0 && (
                <SessionLevelsCard levels={sessionLevels} price={price} />
              )}

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>
                    Support & Resistance · {active.definition.executionTimeframe}
                  </CardEyebrow>
                  <InfoHint text="Support is where buyers stepped in before (price floor); resistance is where sellers did (price ceiling). A long is best entered near support, a short near resistance." />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <LevelStat
                    label="Support"
                    value={formatMoney(active.execution.analytics.support)}
                    tone="bullish"
                  />
                  <LevelStat
                    label="Resistance"
                    value={formatMoney(active.execution.analytics.resistance)}
                    tone="bearish"
                  />
                </div>
              </div>
            </TabsContent>

            {/* 4 — DETAILS: market context and the engine's scored checks. */}
            <TabsContent value="details" className="mt-0 space-y-3">
              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Market Read</CardEyebrow>
                  <InfoHint text="What the two timeframes behind your objective are doing. When they disagree it doesn't mean 'no trade' — it changes which objectives are payable and which should wait." />
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <BiasCell
                    label={`${active.definition.contextTimeframe} context`}
                    regime={active.context.regime}
                    bias={active.contextBias}
                  />
                  <BiasCell
                    label={`${active.definition.executionTimeframe} trigger`}
                    regime={active.execution.regime}
                    bias={active.executionBias}
                  />
                </div>
              </div>

              <TokenEventsCard symbol={symbol} />

              <StructureAlignmentCard
                structures={structuresByTimeframe}
                contextTimeframe={active.definition.contextTimeframe}
                executionTimeframe={active.definition.executionTimeframe}
              />

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Conditions · {active.definition.executionTimeframe}</CardEyebrow>
                  <InfoHint text="The market's current condition in plain words — trend, momentum, volume, volatility, and the swing structure (higher or lower highs and lows) the engine reads from the chart — with the exact ATR and volume readings below. Bigger ATR means wilder swings." />
                </div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {keyInsights(active.execution).map((row) => (
                    <KeyInsightBox key={row.label} {...row} />
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <LevelStat
                    label="ATR (14)"
                    value={
                      active.execution.analytics.atrPercent !== null
                        ? `${active.execution.analytics.atrPercent}%`
                        : "n/a"
                    }
                  />
                  <LevelStat
                    label="Vol vs 20-bar"
                    value={
                      active.execution.analytics.volumeRatio !== null
                        ? `${active.execution.analytics.volumeRatio}×`
                        : "n/a"
                    }
                  />
                </div>
              </div>

              {perp && <PerpContextCard perp={perp} />}

              <FundingPlayPanel symbol={symbol} market={marketType} />

              <div data-tour="insight" className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Engine Checks · {active.definition.executionTimeframe}</CardEyebrow>
                  <InfoHint text="Every check the engine ran with its score contribution. Hover a check to read what it found. Green passed, amber is a caution, red failed." />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {active.execution.components.map((component) => (
                    <Tooltip key={component.name}>
                      <TooltipTrigger asChild>
                        <div className="flex cursor-default items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
                          <StatusIcon status={component.status} />
                          <span className="whitespace-nowrap text-[11px] font-semibold">
                            {component.name}
                          </span>
                          <StatusBadge status={component.status} score={component.score} />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        className="max-w-[260px] bg-popover text-xs leading-relaxed text-popover-foreground shadow-lg"
                      >
                        {component.explanation}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            </TabsContent>

            {/* 3 — EVIDENCE: the engine's live record. */}
            <TabsContent value="evidence" className="mt-0 space-y-3">
              {active.record && (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-lg border p-2.5 text-[11px] leading-relaxed",
                    active.record.demoted
                      ? "border-warning/30 bg-warning-soft text-warning"
                      : "border-border bg-surface text-muted-foreground",
                  )}
                >
                  <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <span className="text-[9px] font-semibold uppercase tracking-wider">
                      Engine's live record
                    </span>
                    <p className="mt-0.5">{active.record.note}</p>
                  </div>
                </div>
              )}

              <AnticipatoryRecordNote />
            </TabsContent>
          </div>
        </Tabs>
      )}

      <Dialog open={followDialogOpen} onOpenChange={setFollowDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Follow {symbol}</DialogTitle>
            <DialogDescription>
              {active &&
                `Confirm the price you actually entered at — the engine's ideal zone was ${formatEntryRange(active.plan?.entryLow ?? 0, active.plan?.entryHigh ?? 0)}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label
              htmlFor="follow-entry-price"
              className="text-xs font-medium text-muted-foreground"
            >
              Your entry price
            </label>
            <Input
              id="follow-entry-price"
              type="number"
              step="any"
              value={entryPriceInput}
              onChange={(e) => setEntryPriceInput(e.target.value)}
              autoFocus
            />
          </div>
          {active?.plan && (
            <div className="grid grid-cols-3 gap-1.5 text-xs">
              <RiskMetric
                label="Stop"
                value={formatMoney(active.plan.stop)}
                tone="bearish"
                compact
              />
              <RiskMetric
                label="Target 1"
                value={formatMoney(active.plan.target1)}
                tone="bullish"
                compact
              />
              <RiskMetric
                label="Target 2"
                value={formatMoney(active.plan.target2)}
                tone="bullish"
                compact
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFollowDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmFollow}>Confirm and track</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </IqCard>
  );
}

function formatHeldFor(heldAt: string): string {
  const ms = Date.now() - Date.parse(heldAt);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function HoldNote({ hold }: { hold: DisplayIntentAssessment["hold"] }) {
  if (hold.isHeld) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
        <Lock className="h-3 w-3 shrink-0" />
        <span>
          Verdict held {formatHeldFor(hold.heldAt)} — it stands until a trigger below fires, so it
          won't flicker between refreshes.
        </span>
      </div>
    );
  }
  if (hold.adoptedBecause) {
    return (
      <div className="mt-1.5 flex items-start gap-1.5 text-[10px] font-medium text-info">
        <MoveRight className="mt-0.5 h-3 w-3 shrink-0" />
        <span>Updated: {hold.adoptedBecause}</span>
      </div>
    );
  }
  return null;
}

/**
 * Compact status line for the Phase 0.5 anticipatory fill-model record —
 * global across symbols, measurement only, read by no verdict (EDR 0010).
 * Hidden until at least one record has decided its fill, so the Evidence tab
 * doesn't advertise an empty ledger.
 */
function AnticipatoryRecordNote() {
  const signals = useAnticipatorySignalsStore((s) => s.signals);
  const summary = summarizeAnticipatoryRecord(signals);
  if (summary.filled + summary.neverFilled === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-surface p-2.5 text-[11px] leading-relaxed text-muted-foreground">
      <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          Anticipatory limit record (all symbols)
        </span>
        <p className="mt-0.5">
          {summary.fillRate}% of resting limits filled ({summary.filled} of{" "}
          {summary.filled + summary.neverFilled} decided
          {summary.pending > 0 ? `, ${summary.pending} still resting` : ""}).
          {summary.settled > 0
            ? ` Filled positions: ${summary.winRate}% wins, ${summary.averageR >= 0 ? "+" : ""}${summary.averageR}R avg over ${summary.settled} settled${summary.lowSample ? " — small sample, treat as anecdote" : ""}.`
            : " No filled position has settled yet."}
        </p>
      </div>
    </div>
  );
}

function SessionLevelsCard({ levels, price }: { levels: SessionLevel[]; price: number }) {
  // The single high/low across all sessions that price is currently nearest —
  // the level most likely to act as immediate support/resistance.
  let nearestKey = "";
  let nearestDist = Infinity;
  for (const l of levels) {
    for (const kind of ["high", "low"] as const) {
      const p = kind === "high" ? l.high : l.low;
      const d = Math.abs(p - price);
      if (d < nearestDist) {
        nearestDist = d;
        nearestKey = `${l.session}-${kind}`;
      }
    }
  }

  const pill = (session: string, kind: "high" | "low", value: number) => {
    const deltaPct = ((value - price) / price) * 100;
    const highlight = nearestKey === `${session}-${kind}`;
    return (
      <div
        className={cn(
          "flex flex-1 items-baseline justify-between rounded-md border px-2 py-1",
          highlight
            ? "border-info/40 bg-info-soft text-info"
            : "border-border bg-card text-muted-foreground",
        )}
      >
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          {kind === "high" ? "H" : "L"}
        </span>
        <span className="num text-[11px] font-semibold">{formatMoney(value)}</span>
        <span className="num text-[9px]">
          {deltaPct >= 0 ? "+" : ""}
          {deltaPct.toFixed(1)}%
        </span>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center gap-1.5">
        <CardEyebrow>Session Levels</CardEyebrow>
        <InfoHint text="The high and low each trading region (Asia, London, New York) printed in its most recent completed session. Yesterday's session extremes are the intraday levels traders lean on — reclaiming a session high or holding a session low is a structure event. The level price is nearest is highlighted; the verdict's entry-location read counts a session level you're holding as structure." />
      </div>
      <div className="mt-2 space-y-1">
        {levels.map((l) => (
          <div key={l.session} className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-[10px] font-semibold text-foreground">
              {l.label}
            </span>
            {pill(l.session, "high", l.high)}
            {pill(l.session, "low", l.low)}
          </div>
        ))}
      </div>
    </div>
  );
}

function PerpContextCard({ perp }: { perp: PerpRead }) {
  const fundingTone =
    perp.fundingBias === "neutral"
      ? "border-border bg-muted text-muted-foreground"
      : perp.fundingExtreme
        ? "border-bearish/30 bg-bearish-soft text-bearish"
        : "border-warning/30 bg-warning-soft text-warning";
  const fundingLabel =
    perp.fundingBias === "longs-crowded"
      ? "Longs crowded"
      : perp.fundingBias === "shorts-crowded"
        ? "Shorts crowded"
        : "Balanced";
  const apr = `${perp.fundingAnnualizedPct > 0 ? "+" : ""}${perp.fundingAnnualizedPct.toFixed(0)}%`;
  const oiTone =
    perp.oiTrend === "rising"
      ? "text-info"
      : perp.oiTrend === "falling"
        ? "text-muted-foreground"
        : "text-foreground";
  const oiChange = `${perp.oiChangePct > 0 ? "+" : ""}${perp.oiChangePct.toFixed(1)}%`;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <CardEyebrow>Perp Positioning</CardEyebrow>
          <InfoHint text="Funding + open interest — what perp traders check first. Positive funding means longs are paying to hold (crowded long, flush risk); negative means shorts are paying (crowded short, squeeze risk). Rising open interest means fresh money is behind the move; falling means positions are being closed. The verdict trims size when funding is extreme with the crowd already on your side." />
        </div>
        <Badge variant="outline" className={cn("shrink-0", fundingTone)}>
          {fundingLabel}
        </Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <div className="rounded-md border border-border bg-card px-2 py-1.5">
          <div className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            <Scale className="h-3 w-3" />
            Funding · 8h
          </div>
          <div className="num mt-0.5 text-sm font-semibold text-foreground">
            {(perp.fundingRate * 100).toFixed(4)}%
          </div>
          <div className="text-[10px] text-muted-foreground">{apr} annualized</div>
        </div>
        <div className="rounded-md border border-border bg-card px-2 py-1.5">
          <div className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            <Activity className="h-3 w-3" />
            Open interest
          </div>
          <div className="num mt-0.5 text-sm font-semibold text-foreground">
            {perp.openInterestValue > 0 ? `$${formatCompact(perp.openInterestValue)}` : "—"}
          </div>
          <div className={cn("text-[10px] font-medium", oiTone)}>{oiChange} · 24h</div>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{perp.note}</p>
    </div>
  );
}

function LocationRow({
  location,
  support,
  resistance,
}: {
  location: NonNullable<DisplayIntentAssessment["location"]>;
  support: number | null;
  resistance: number | null;
}) {
  const tone =
    location.grade === "at-structure"
      ? { chip: "border-bullish/30 bg-bullish-soft text-bullish", marker: "bg-bullish" }
      : location.grade === "extended"
        ? { chip: "border-warning/30 bg-warning-soft text-warning", marker: "bg-warning" }
        : { chip: "border-info/30 bg-info-soft text-info", marker: "bg-info" };
  const pct = Math.round(Math.min(1, Math.max(0, location.rangePosition)) * 100);

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <CardEyebrow>Entry Location</CardEyebrow>
          <InfoHint text="Where price sits between support and resistance for this trade's direction. A long is best entered near support, a short near resistance — 'favored' is reserved for well-located setups, and an extended price becomes 'wait for a pullback' even when the direction is right." />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {location.confluence !== "none" && (
            <Badge
              variant="outline"
              className={cn(
                location.confluence === "multi-timeframe"
                  ? "border-bullish/40 bg-bullish-soft text-bullish"
                  : "border-info/30 bg-info-soft text-info",
              )}
            >
              <Layers className="mr-1 h-3 w-3" />
              {location.confluence === "multi-timeframe" ? "MTF confluence" : "Zone-backed"}
            </Badge>
          )}
          <Badge variant="outline" className={cn(tone.chip)}>
            {location.label}
          </Badge>
        </div>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-muted">
        <div
          className={cn("absolute -top-1 h-3.5 w-1 rounded-full", tone.marker)}
          style={{ left: `calc(${pct}% - 2px)` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>S {support !== null ? formatMoney(support) : "—"}</span>
        <span>R {resistance !== null ? formatMoney(resistance) : "—"}</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{location.note}</p>
    </div>
  );
}

function verdictTone(assessment: IntentAssessment): string {
  if (assessment.verdict === "favored")
    return assessment.direction === "short"
      ? "border-bearish/30 bg-bearish-soft"
      : "border-bullish/30 bg-bullish-soft";
  if (assessment.verdict === "caution") return "border-warning/30 bg-warning-soft";
  if (assessment.verdict === "wait") return "border-info/30 bg-info-soft";
  return "border-border bg-muted/40";
}

/**
 * The five-second read: one big colored word for the verdict. Favored/caution
 * lead with the direction itself; wait and avoid lead with the answer. The
 * badges keep the counter-trend/half-size nuance the old text badge carried.
 */
function VerdictHero({ assessment }: { assessment: DisplayIntentAssessment }) {
  const { verdict, direction, isCounterTrend, sizeMultiplier } = assessment;
  const DirIcon =
    direction === "long" ? TrendingUp : direction === "short" ? TrendingDown : MoveRight;
  const word =
    verdict === "favored" || verdict === "caution"
      ? direction.toUpperCase()
      : verdict === "wait"
        ? direction === "none"
          ? "NOT YET"
          : `${direction.toUpperCase()} · NOT YET`
        : "STAND ASIDE";
  const text =
    verdict === "favored"
      ? direction === "short"
        ? "text-bearish"
        : "text-bullish"
      : verdict === "caution"
        ? "text-warning"
        : verdict === "wait"
          ? "text-info"
          : "text-muted-foreground";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DirIcon className={cn("h-6 w-6 shrink-0", text)} />
      <span className={cn("text-2xl font-bold leading-none tracking-tight", text)}>{word}</span>
      {sizeMultiplier < 1 && (
        <Badge variant="outline" className="border-warning/30 bg-warning-soft text-warning">
          ½ size
        </Badge>
      )}
      {isCounterTrend && (
        <Badge variant="outline" className="border-warning/30 bg-warning-soft text-warning">
          counter-trend
        </Badge>
      )}
    </div>
  );
}

/**
 * The engine's confidence, presented as what it actually is: the strength of
 * the *directional read*, not permission to act. The number is never rescaled
 * or capped — hysteresis and the tracker store this same raw value — but the
 * ring takes the verdict's color and the hint states the verdict's meaning,
 * so "NOT YET beside a high number" reads as "strong read, entry conditions
 * not yet satisfied" rather than a contradiction.
 */
function ReadStrengthGauge({ assessment }: { assessment: DisplayIntentAssessment }) {
  const { verdict, direction } = assessment;
  const tone =
    verdict === "favored"
      ? direction === "short"
        ? "var(--color-bearish)"
        : "var(--color-bullish)"
      : verdict === "caution"
        ? "var(--color-warning)"
        : verdict === "wait"
          ? "var(--color-info)"
          : "var(--color-muted-foreground)";
  const meaning =
    verdict === "favored"
      ? "Here the read and the entry conditions agree — the setup is confirmed."
      : verdict === "caution"
        ? "The read is tradable but fights the higher timeframe — hence reduced size."
        : verdict === "wait"
          ? "A strong number beside 'not yet' is not a contradiction: the engine is confident about the direction while the entry conditions are still unsatisfied — the checklist shows exactly what's missing."
          : "Whatever its strength, this market doesn't pay your objective — stand aside.";
  return (
    <div className="flex shrink-0 flex-col items-center">
      <ConfidenceGauge value={assessment.confidence} size={60} tone={tone} />
      <span className="mt-0.5 flex items-center gap-1 text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">
        Read strength
        <InfoHint
          text={`How strongly the engine's evidence points in one direction — signal strength, not a win probability. The verdict word is the action. ${meaning}`}
        />
      </span>
    </div>
  );
}

/** R:R to each target and risk level — the ref-style stat row. */
function EdgeStats({ assessment }: { assessment: DisplayIntentAssessment }) {
  const risk = assessment.execution.risk;
  const atr = assessment.execution.analytics.atrPercent;
  // The engine owns the risk formula (ATR bands + counter-trend bump).
  const grade = gradeRisk(atr, assessment.isCounterTrend);
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <GlanceStat
        label="R:R to T1"
        value={`${risk.rewardRisk1}R`}
        sub="target 1 vs. stop"
        tone={risk.rewardRisk1 >= 1 ? "bullish" : undefined}
      />
      <GlanceStat
        label="R:R to T2"
        value={`${risk.rewardRisk2}R`}
        sub="target 2 vs. stop"
        tone={risk.rewardRisk2 >= 1 ? "bullish" : undefined}
      />
      <GlanceStat
        label="Risk level"
        value={grade ? grade[0].toUpperCase() + grade.slice(1) : "n/a"}
        sub={
          [atr !== null ? `ATR ${atr}%` : null, assessment.isCounterTrend ? "counter-trend" : null]
            .filter(Boolean)
            .join(" · ") || "no ATR read"
        }
        tone={grade === "high" ? "bearish" : grade === "medium" ? "warning" : undefined}
      />
    </div>
  );
}

function GlanceStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "bullish" | "bearish" | "warning";
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-2">
      <div className="truncate text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 truncate text-sm font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
      <div className="truncate text-[9px] text-muted-foreground">{sub}</div>
    </div>
  );
}

/** One trade-plan level, ref-style: colored dot, label, monospaced price. */
function PlanRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span className="num truncate text-[11px] font-semibold">{value}</span>
    </div>
  );
}

/**
 * Mini vertical map of the plan: green reward band up to T1 (fainter on to
 * T2), blue entry pocket, red risk band to the stop — the same bands the
 * chart's trade zones paint, at a glance next to the numbers. Orientation
 * follows the actual prices, so shorts render inverted automatically.
 */
function PlanLadder({ plan }: { plan: RiskRewardPlan }) {
  const prices = [plan.stop, plan.entry, plan.entryLow, plan.entryHigh, plan.target1, plan.target2];
  if (prices.some((value) => !Number.isFinite(value))) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (!(max > min)) return null;
  const pct = (value: number) => ((max - value) / (max - min)) * 100;
  const band = (a: number, b: number) => ({
    top: `${Math.min(pct(a), pct(b))}%`,
    height: `${Math.max(1.5, Math.abs(pct(a) - pct(b)))}%`,
  });
  return (
    <div
      aria-hidden
      className="relative w-9 shrink-0 self-stretch overflow-hidden rounded-md border border-border bg-surface"
    >
      <div
        className="absolute inset-x-1 rounded-sm bg-bullish/10"
        style={band(plan.target1, plan.target2)}
      />
      <div
        className="absolute inset-x-1 rounded-sm bg-bullish/25"
        style={band(plan.entry, plan.target1)}
      />
      <div
        className="absolute inset-x-1 rounded-sm bg-bearish/25"
        style={band(plan.entry, plan.stop)}
      />
      <div
        className="absolute inset-x-0 rounded-sm border border-info/50 bg-info/30"
        style={band(plan.entryLow, plan.entryHigh)}
      />
    </div>
  );
}

function VerdictDot({ assessment }: { assessment: IntentAssessment | undefined }) {
  return (
    <span
      className={cn(
        "h-1 w-1 rounded-full",
        !assessment && "bg-muted-foreground/30",
        assessment?.verdict === "favored" &&
          (assessment.direction === "short" ? "bg-bearish" : "bg-bullish"),
        assessment?.verdict === "caution" && "bg-warning",
        assessment?.verdict === "wait" && "bg-info",
        assessment?.verdict === "avoid" && "bg-muted-foreground/30",
      )}
    />
  );
}

function BiasCell({
  label,
  regime,
  bias,
}: {
  label: string;
  regime: MarketRegime;
  bias: TradeDirection;
}) {
  const Icon = bias === "long" ? TrendingUp : bias === "short" ? TrendingDown : MoveRight;
  return (
    <div className="rounded-md border border-border bg-card px-2 py-1.5">
      <div className="text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 flex items-center gap-1 truncate text-[11px] font-semibold capitalize",
          bias === "long" && "text-bullish",
          bias === "short" && "text-bearish",
        )}
      >
        {regime.replaceAll("-", " ")}
        <Icon className="h-3 w-3 shrink-0" />
      </div>
    </div>
  );
}

/**
 * The Overview's one-line status: what stands between you and the trade (or
 * what pays instead), without the prose — the Why tab carries the full
 * reasoning. This is the "not-yet / wrong-strategy / what-flips-it" answer
 * compressed to a glance.
 */
function DecisionBanner({
  active,
  assessments,
}: {
  active: DisplayIntentAssessment;
  assessments: DisplayIntentAssessment[];
}) {
  const done = active.checklist.filter((item) => item.done).length;
  const total = active.checklist.length;
  const next = active.checklist.find((item) => !item.done);
  const heldFor = active.hold.isHeld ? formatHeldFor(active.hold.heldAt) : null;

  let tone: string;
  let Icon: typeof CheckCircle2;
  let headline: string;
  let detail: string | null;
  if (active.verdict === "favored") {
    tone = "border-bullish/30 bg-bullish-soft text-bullish";
    Icon = CheckCircle2;
    headline = `Setup confirmed — ${done}/${total} checks in`;
    detail = next ? `Open: ${next.label}` : null;
  } else if (active.verdict === "caution") {
    tone = "border-warning/30 bg-warning-soft text-warning";
    Icon = ShieldAlert;
    headline = active.isCounterTrend ? "Counter-trend — tradable at ½ size" : "Tradable at ½ size";
    detail = next
      ? `${total - done} check${total - done === 1 ? "" : "s"} open — next: ${next.label}`
      : null;
  } else if (active.verdict === "wait") {
    tone = "border-info/30 bg-info-soft text-info";
    Icon = CircleAlert;
    const extended = active.location?.grade === "extended";
    headline = extended
      ? `No entry at current price — ${total - done} of ${total} confirmations missing`
      : `Not yet — ${total - done} of ${total} confirmations missing`;
    detail = next
      ? `Next: ${next.label}${
          active.plan
            ? ""
            : extended
              ? " · plan appears once price returns to the zone"
              : " · plan appears once the trigger confirms"
        }`
      : null;
  } else {
    tone = "border-border bg-muted/40 text-muted-foreground";
    Icon = CircleX;
    headline = "Doesn't pay this objective";
    const alt = assessments.find(
      (a) =>
        a.intent !== active.intent &&
        (a.verdict === "favored" || a.verdict === "caution") &&
        a.plan !== null,
    );
    detail = alt
      ? `${alt.definition.label} has a ${alt.direction} setup on the ${alt.definition.executionTimeframe}`
      : "No other objective is payable — flat is a position";
  }

  return (
    <div className={cn("flex items-start gap-2 rounded-lg border p-2.5", tone)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[11px] font-semibold">{headline}</div>
        {detail && <div className="mt-0.5 truncate text-[10px] opacity-80">{detail}</div>}
      </div>
      {heldFor && (
        <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold uppercase tracking-wider opacity-80">
          <Lock className="h-3 w-3" />
          held {heldFor}
        </span>
      )}
    </div>
  );
}

// When there is nothing to execute for the chosen objective, say what would
// pay instead — "no trade" should read as "wrong objective", not "go away".
function planEmptyMessage(active: IntentAssessment, assessments: IntentAssessment[]): string {
  const alt = assessments.find(
    (a) =>
      a.intent !== active.intent &&
      (a.verdict === "favored" || a.verdict === "caution") &&
      a.plan !== null,
  );
  const extended = active.verdict === "wait" && active.location?.grade === "extended";
  const base = extended
    ? active.anticipatoryPlan
      ? `No ${active.direction} at current price — price is extended into structure. If it ${active.direction === "long" ? "pulls back" : "rallies"} to ${formatMoney(active.anticipatoryPlan.zone.priceLow)}–${formatMoney(active.anticipatoryPlan.zone.priceHigh)}, a ${active.direction} becomes viable (see the conditional setup below).`
      : `No ${active.direction} at current price — price is extended into structure. Wait for a pullback.`
    : active.verdict === "wait"
      ? "No entry yet — the plan appears the moment the trigger confirms."
      : "This market doesn't pay your objective right now.";
  if (alt) {
    return `${base} If you want action today, the ${alt.definition.label.toLowerCase()} objective has a ${alt.verdict === "caution" ? "reduced-size " : ""}${alt.direction} setup on the ${alt.definition.executionTimeframe}.`;
  }
  return `${base} No other objective has a payable setup either — flat is a position.`;
}

function SizingNote({ multiplier = 1 }: { multiplier?: number }) {
  const risk = usePreferencesStore((s) => s.risk);
  return (
    <p className="text-[10px] leading-relaxed text-muted-foreground">
      Sized for a ${risk.accountSize.toLocaleString()} account risking {risk.maxRiskPerTradePercent}
      % per trade ({risk.stopMethod.replaceAll("-", " ")} stop).
      {multiplier < 1 && (
        <span className="font-semibold text-warning">
          {" "}
          Shown at half size — counter-trend for this objective.
        </span>
      )}{" "}
      <Link to="/settings" className="font-semibold text-info hover:underline">
        Adjust →
      </Link>
    </p>
  );
}

interface InsightRow {
  label: string;
  value: string;
  tone: "bullish" | "bearish" | "warning" | "neutral";
  dir: "up" | "down" | "flat";
  /** Span the full grid row — for the structure summary, which needs the width. */
  wide?: boolean;
}

function keyInsights(evaluation: SignalEvaluation): InsightRow[] {
  const a = evaluation.analytics;
  const trend: InsightRow =
    evaluation.regime === "trending-up"
      ? { label: "Trend", value: "Uptrend", tone: "bullish", dir: "up" }
      : evaluation.regime === "trending-down"
        ? { label: "Trend", value: "Downtrend", tone: "bearish", dir: "down" }
        : { label: "Trend", value: "Sideways", tone: "neutral", dir: "flat" };

  const aboveMean = a.sma20 !== null && a.lastClose > a.sma20;
  const momentum: InsightRow = aboveMean
    ? { label: "Momentum", value: "Positive", tone: "bullish", dir: "up" }
    : { label: "Momentum", value: "Weak", tone: "bearish", dir: "down" };

  const ratio = a.volumeRatio ?? 1;
  const volume: InsightRow =
    ratio >= 1.15
      ? { label: "Volume", value: "Above avg", tone: "bullish", dir: "up" }
      : ratio <= 0.85
        ? { label: "Volume", value: "Below avg", tone: "warning", dir: "down" }
        : { label: "Volume", value: "Average", tone: "neutral", dir: "flat" };

  // Same engine formula the Overview risk chip reads — the two can't diverge.
  const atrGrade = gradeRisk(a.atrPercent);
  const volatility: InsightRow =
    atrGrade === "high"
      ? { label: "Volatility (ATR)", value: "High", tone: "bearish", dir: "up" }
      : atrGrade === "medium"
        ? { label: "Volatility (ATR)", value: "Medium", tone: "warning", dir: "flat" }
        : { label: "Volatility (ATR)", value: "Low", tone: "neutral", dir: "flat" };

  // Swing structure is a separate read from the regime above: the regime is
  // MA/ATR-derived, structure is the HH/HL/LH/LL sequence of validated swing
  // legs. A break event is only news while it sits on the most recent swing.
  const s = evaluation.structure;
  const eventCurrent =
    s.event && s.eventSwing && (s.eventSwing === s.lastHigh || s.eventSwing === s.lastLow);
  const eventNote = eventCurrent ? (s.event === "bos" ? " · BOS" : " · CHoCH") : "";
  const structure: InsightRow =
    s.trend === "uptrend"
      ? {
          label: "Structure",
          value: `Higher highs & higher lows${eventNote}`,
          tone: "bullish",
          dir: "up",
          wide: true,
        }
      : s.trend === "downtrend"
        ? {
            label: "Structure",
            value: `Lower highs & lower lows${eventNote}`,
            tone: "bearish",
            dir: "down",
            wide: true,
          }
        : {
            label: "Structure",
            value: `Range — ${s.lastHigh?.label ?? "–"} high / ${s.lastLow?.label ?? "–"} low${eventNote}`,
            tone: "neutral",
            dir: "flat",
            wide: true,
          };

  return [trend, momentum, volume, volatility, structure];
}

function KeyInsightBox({ label, value, tone, dir, wide }: InsightRow) {
  const DirIcon = dir === "up" ? TrendingUp : dir === "down" ? TrendingDown : MoveRight;
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-surface p-2",
        wide && "col-span-2 sm:col-span-4",
      )}
    >
      <div className="text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 flex items-center gap-1 truncate text-xs font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
        <DirIcon className="h-3 w-3 shrink-0" />
      </div>
    </div>
  );
}

function TradeDrawer({
  symbol,
  ticket,
  logContext,
  open,
  onOpenChange,
  timeframe,
  evaluation,
  assessment,
  chartStructure,
  externalContext,
}: {
  symbol: string;
  ticket: Partial<TradeTicketState>;
  logContext?: ExecutionLogContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeframe?: TokenTimeframe;
  evaluation?: SignalEvaluation;
  assessment?: DisplayIntentAssessment | null;
  chartStructure?: ChartStructure | null;
  externalContext?: ExternalContext | null;
}) {
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const aiProvider = useAiSettingsStore((s) => s.provider);
  const aiApiKeys = useAiSettingsStore((s) => s.apiKeys);
  const aiModels = useAiSettingsStore((s) => s.models);
  const aiCustomBaseUrl = useAiSettingsStore((s) => s.customBaseUrl);
  const aiConfig = useMemo(
    () =>
      resolveAiConfig({
        provider: aiProvider,
        apiKeys: aiApiKeys,
        models: aiModels,
        customBaseUrl: aiCustomBaseUrl,
      }),
    [aiProvider, aiApiKeys, aiModels, aiCustomBaseUrl],
  );

  useEffect(() => {
    if (!open || !evaluation || analysis || loading) return;

    const fallback = () =>
      deterministicFallback({
        symbol,
        range: timeframe || "1H",
        evaluation,
        assessment: assessment || null,
        thinkingMode: false,
      });

    if (!aiConfig) {
      setAnalysis(fallback());
      return;
    }

    setLoading(true);
    const system = buildAnalystSystem(
      symbol,
      timeframe || "1H",
      evaluation,
      assessment || null,
      false, // thinkingMode
      chartStructure || null,
      externalContext || null,
    );

    runAiAnalyst({
      config: aiConfig,
      system,
      messages: [
        {
          role: "user",
          content:
            "Provide a concise, 1-2 sentence quick note summarizing the core logic of this trade setup. Keep it very brief.",
        },
      ],
    })
      .then((text) => setAnalysis(text))
      .catch(() => setAnalysis(fallback()))
      .finally(() => setLoading(false));
  }, [
    open,
    evaluation,
    analysis,
    loading,
    aiConfig,
    symbol,
    timeframe,
    assessment,
    chartStructure,
    externalContext,
  ]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2 pr-10">
          <div className="flex min-w-0 items-center gap-2">
            <Zap className="h-4 w-4 shrink-0 text-primary" />
            <SheetTitle className="truncate text-xs font-bold">{symbol} Trade</SheetTitle>
            <InfoHint text="Requests a constitution-gated permit using this token's current execution plan. The backend rechecks account state and derives executable quantity from the persisted permit snapshot." />
          </div>
          {/* Echo the plan this was opened from, so the drawer never reads as
              a disconnected detour from the Plan tab it was launched from. */}
          {assessment?.plan && assessment.direction !== "none" && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] font-bold uppercase",
                  assessment.direction === "short"
                    ? "border-bearish/30 bg-bearish-soft text-bearish"
                    : "border-bullish/30 bg-bullish-soft text-bullish",
                )}
              >
                {assessment.direction}
              </Badge>
              <span className="num text-muted-foreground">
                Entry {formatEntryRange(assessment.plan.entryLow, assessment.plan.entryHigh)} · Stop{" "}
                {formatMoney(assessment.plan.stop)} · T1 {formatMoney(assessment.plan.target1)}
              </span>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 flex flex-col gap-4">
          <ExecutionPanel initialTicket={ticket} logContext={logContext} className="w-full" />

          {evaluation && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex items-center gap-2 font-bold mb-2 text-muted-foreground text-[10px] uppercase tracking-wider">
                <Brain className="h-3.5 w-3.5" /> Setup Analysis
              </div>
              {loading ? (
                <div className="animate-pulse text-muted-foreground italic text-xs">
                  Generating AI Analysis...
                </div>
              ) : (
                <div className="prose prose-sm dark:prose-invert text-xs leading-relaxed max-w-none">
                  {analysis && <MarkdownText text={analysis} />}
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function deterministicFallback(req: {
  symbol: string;
  range: string;
  evaluation: SignalEvaluation;
  assessment?: DisplayIntentAssessment | null;
  question?: string;
  thinkingMode: boolean;
}): string {
  const e = req.evaluation;
  const held = req.assessment?.hold.isHeld;
  const lines = [
    `### Quant memo: ${req.assessment ? req.assessment.headline : e.decision.replaceAll("-", " ")}`,
    ``,
    ...(req.assessment
      ? [
          `- **Your objective (${req.assessment.definition.label}):** ${req.assessment.summary}`,
          ...(held
            ? [
                `- **Held call:** this verdict was adopted ${formatHeldFor(req.assessment.hold.heldAt)} ago and stands until its own trigger fires — the setup below is live and may have already moved on without releasing it.`,
              ]
            : []),
        ]
      : []),
    `- **Setup:** ${e.setupType.replaceAll("-", " ")}`,
    `- **Regime:** ${e.regime.replaceAll("-", " ")}`,
    `- **Signal strength:** ${e.confidence}/100 (heuristic checklist score, not a win probability)`,
    `- **Risk plan:** entry zone \`${e.risk.entryLow}–${e.risk.entryHigh}\`, stop \`${e.risk.stop}\`, target 1 \`${e.risk.target1}\`, target 2 \`${e.risk.target2}\``,
    `- **Position:** ${e.risk.positionSize} units, max loss \`${e.risk.maxDollarLoss}\`, target 1 reward \`${e.risk.rewardRisk1}R\``,
  ];
  if (e.noTradeReasons.length) {
    lines.push(`- **Primary blocker:** ${e.noTradeReasons[0]}`);
  } else {
    lines.push(`- **Action:** ${e.reason}`);
  }
  const strongest = [...e.components].sort((a, b) => b.score - a.score)[0];
  const weakest = [...e.components].sort((a, b) => a.score - b.score)[0];
  if (strongest) lines.push(`- **Best evidence:** ${strongest.name} - ${strongest.explanation}`);
  if (weakest && weakest.score < 0)
    lines.push(`- **Risk evidence:** ${weakest.name} - ${weakest.explanation}`);
  if (req.question) lines.push(`\n### Prompt\n- ${req.question}`);
  return lines.join("\n");
}

function PerpLeverage({
  plan,
  leverage,
  onLeverage,
}: {
  plan: NonNullable<IntentAssessment["plan"]>;
  leverage: number;
  onLeverage: (value: number) => void;
}) {
  const metrics = computeLeverageMetrics(
    plan.entry,
    plan.stop,
    plan.positionSize,
    plan.direction,
    leverage,
  );
  if (!metrics) return null;

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Leverage
          <InfoHint text="Leverage doesn't change the risk-sized position — the same units and max loss hold. It only sets the margin you post and where you'd be liquidated. Keep leverage at or below 'Max safe' so your stop triggers before liquidation. Liquidation is an estimate; it excludes fees and funding." />
        </span>
        <span className="num text-sm font-semibold text-foreground">{leverage}×</span>
      </div>
      <Slider
        min={MIN_LEVERAGE}
        max={MAX_LEVERAGE}
        step={1}
        value={[leverage]}
        onValueChange={([value]) => onLeverage(value)}
        aria-label="Leverage"
      />
      <div className="grid grid-cols-2 gap-1.5">
        <RiskMetric label="Margin" value={formatMoney(metrics.margin)} compact />
        <RiskMetric label="Notional" value={formatMoney(metrics.notional)} compact />
        <RiskMetric
          label="Est. liquidation"
          value={formatMoney(metrics.liquidation)}
          tone={metrics.liquidatesBeforeStop ? "bearish" : undefined}
          compact
        />
        <RiskMetric label="Max safe" value={`${metrics.maxSafeLeverage}×`} compact />
      </div>
    </div>
  );
}

/**
 * Leverage-aware invalidation check: does your stop (the trade's invalidation)
 * actually get to do its job, or does liquidation come first? At high leverage
 * the estimated liquidation can sit in front of the stop — the idea never even
 * gets the chance to be proven wrong. This reads out the current leverage's
 * verdict and, when unsafe, the leverage that restores a real stop.
 */
function LiquidationCheck({
  plan,
  leverage,
}: {
  plan: NonNullable<IntentAssessment["plan"]>;
  leverage: number;
}) {
  const metrics = computeLeverageMetrics(
    plan.entry,
    plan.stop,
    plan.positionSize,
    plan.direction,
    leverage,
  );
  if (!metrics) return null;

  const bufferPct = Math.abs(metrics.stopToLiquidationBufferPct) * 100;
  const tone =
    metrics.liquidationSafety === "safe"
      ? { box: "border-bullish/30 bg-bullish-soft text-bullish", Icon: ShieldCheck }
      : metrics.liquidationSafety === "thin"
        ? { box: "border-warning/30 bg-warning-soft text-warning", Icon: ShieldAlert }
        : { box: "border-bearish/30 bg-bearish-soft text-bearish", Icon: ShieldAlert };

  const message =
    metrics.liquidationSafety === "danger" ? (
      <>
        At {leverage}× liquidation ({formatMoney(metrics.liquidation)}) triggers{" "}
        <strong>before</strong> your stop ({formatMoney(plan.stop)}) — you'd be liquidated before
        the idea is even invalidated. Drop to {metrics.maxSafeLeverage}× or lower so your stop does
        its job.
      </>
    ) : metrics.liquidationSafety === "thin" ? (
      <>
        Liquidation ({formatMoney(metrics.liquidation)}) sits only {bufferPct.toFixed(1)}% past your
        stop ({formatMoney(plan.stop)}) — a stop-run wick could liquidate you before the trade is
        invalidated. Consider {metrics.maxSafeLeverage}× or lower for more cushion.
      </>
    ) : (
      <>
        Your stop ({formatMoney(plan.stop)}) triggers first; liquidation (
        {formatMoney(metrics.liquidation)}) sits {bufferPct.toFixed(1)}% further out — a{" "}
        {metrics.bufferInStops.toFixed(1)}× stop-distance cushion. Invalidation stays in your
        control.
      </>
    );

  return (
    <div className={cn("flex items-start gap-2 rounded-lg border p-2.5", tone.box)}>
      <tone.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          Liquidation vs invalidation
        </span>
        <p className="mt-0.5 text-[11px] leading-relaxed">{message}</p>
      </div>
    </div>
  );
}

function RiskMetric({
  label,
  value,
  tone,
  compact,
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish";
  compact?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-surface", compact ? "p-2" : "p-2.5")}>
      <div
        className={cn(
          "font-semibold uppercase tracking-wider text-muted-foreground",
          compact ? "text-[9px] leading-tight" : "text-[10px]",
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 truncate font-semibold",
          compact ? "text-xs" : "text-sm",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function LevelStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish";
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
      <span className="text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "num truncate text-[11px] font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function ContextPill({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-2" title={title}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-xs font-semibold capitalize">{value}</div>
    </div>
  );
}

function StatusBadge({ status, score }: { status: SignalStatus; score: number }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "num shrink-0",
        status === "pass" && "border-bullish/30 bg-bullish-soft text-bullish",
        status === "warning" && "border-warning/30 bg-warning-soft text-warning",
        status === "fail" && "border-bearish/30 bg-bearish-soft text-bearish",
        status === "neutral" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {score >= 0 ? "+" : ""}
      {score}
    </Badge>
  );
}

function StatusIcon({ status }: { status: SignalStatus }) {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4 shrink-0 text-bullish" />;
  if (status === "fail") return <CircleX className="h-4 w-4 shrink-0 text-bearish" />;
  if (status === "warning") return <CircleAlert className="h-4 w-4 shrink-0 text-warning" />;
  return <CircleAlert className="h-4 w-4 shrink-0 text-muted-foreground" />;
}
