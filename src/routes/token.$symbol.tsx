import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  SeriesMarker,
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
  Play,
  Scale,
  Send,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Link } from "@tanstack/react-router";

import { AssetIcon } from "@/components/iq/asset-icon";
import { Change } from "@/components/iq/change";
import { ZonesPrimitive, type PriceZone } from "@/components/iq/chart-zones";
import { ConfidenceGauge } from "@/components/iq/confidence-gauge";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { MiniChart } from "@/components/iq/mini-chart";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/iq/product-tour";
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
import {
  describeMarketOutlook,
  INTENTS,
  type IntentAssessment,
  type TradingIntent,
  type ZonesByTimeframe,
} from "@/lib/engine/intent";
import { useReconciledAssessments } from "@/hooks/useReconciledAssessments";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { computeEmaSeries } from "@/lib/engine/analysis";
import { fetchBinanceKlines, type MarketType } from "@/lib/engine/binance";
import type { Candle } from "@/lib/engine/types";
import { UNIVERSE } from "@/lib/engine/market";
import { checkTradableTicker } from "@/lib/engine/symbols";
import { TOKEN_TIMEFRAMES } from "@/lib/engine/mock-candles";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import { computeBaseZones, SD_ZONE_TIMEFRAMES, type BaseZone } from "@/lib/engine/zones";
import type { MarketRegime, SignalEvaluation, SignalStatus } from "@/lib/engine/quant";
import { formatEntryRange, formatMoney, formatUnits } from "@/lib/format";
import { computeLeverageMetrics, MAX_LEVERAGE, MIN_LEVERAGE } from "@/lib/leverage";
import { usePreferencesStore, type ChartIndicatorKey } from "@/stores/preferences";
import { useTrackedSignalsStore } from "@/stores/tracked-signals";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { resolveAiConfig } from "@/lib/ai/providers";
import { runAiAnalyst, type AiMessage } from "@/lib/ai/client";
import {
  buildAnalystSystem,
  buildChartStructure,
  MEMO_INSTRUCTION,
  type ChartStructure,
} from "@/lib/ai/analyst-context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/token/$symbol")({
  head: ({ params }) => ({
    meta: [
      { title: `${params.symbol.toUpperCase()} — Token Signal | IQ` },
      {
        name: "description",
        content: `Quant signal engine, risk plan, and deterministic analyst memo for ${params.symbol.toUpperCase()}.`,
      },
    ],
  }),
  // 404 for pairs Binance doesn't list. "unknown" (directory unreachable)
  // falls through so the demo-candle path still covers offline use.
  loader: async ({ params }) => {
    const symbol = params.symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (UNIVERSE.some((u) => u.ticker === symbol)) return;
    if ((await checkTradableTicker({ data: symbol })) === "invalid") throw notFound();
  },
  notFoundComponent: TokenNotFound,
  component: TokenDetailPage,
});

function TokenNotFound() {
  const { symbol } = Route.useParams();
  const ticker = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
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
    body: "Each candle is one period of price movement (green = closed up, red = closed down). The legend below the chart names every overlay — EMAs, support/resistance, swing points, trade-plan levels — and clicking a legend item hides or shows it (your choices are remembered). When the engine flags a strong setup, shaded zones appear: reward (green), risk (red), and the buy/sell pocket (blue). On 1H and higher timeframes the chart also marks true demand/supply bases — consolidations that launched an explosive move. Drag the chart left past the oldest candle to load more history.",
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
    body: "Not one answer for everyone: the assistant answers for the objective you picked — go, go at reduced size, not yet, or stand aside — and explains why. 'Not yet' is not 'never': the checklist shows exactly which confirmations are missing, and 'what changes this answer' names the price events that would flip today's verdict.",
  },
  {
    target: "risk",
    title: "Execution plan",
    body: "When your objective has a payable setup: entry, stop, profit targets, and a position sized from your account settings — automatically halved when the trade is counter-trend. When there's no plan, the assistant points at the objective that is payable instead.",
  },
  {
    target: "backtest",
    title: "Backtest evidence",
    body: "How this same kind of signal performed historically on this exact chart. Positive expectancy means history is on your side; negative means demand extra confirmation.",
  },
  {
    target: "ai",
    title: "AI analyst",
    body: "Generate a written memo of the whole setup, pick a suggested prompt, or ask your own questions. Collapse it with the Hide button when you want more chart space.",
  },
];

function TokenDetailPage() {
  const { symbol: rawSymbol } = Route.useParams();
  const symbol = rawSymbol.toUpperCase();
  const [timeframe, setTimeframe] = useState<TokenTimeframe>("4H");
  // The AI analyst is now an on-demand drawer, closed by default so the page
  // stays focused on the decision itself.
  const [aiOpen, setAiOpen] = useState(false);
  // The decision panel is organized into tabs that follow the trader's flow
  // (Should I? → Why? → Where? → Risk? → Evidence). Controlled so the product
  // tour can jump to the tab a step lives in.
  const [activeTab, setActiveTab] = useState("decision");
  const tour = useProductTour(TOUR_SEEN_KEY);
  const tradingIntent = usePreferencesStore((s) => s.tradingIntent);
  const setTradingIntent = usePreferencesStore((s) => s.setTradingIntent);
  const marketType = usePreferencesStore((s) => s.marketType);
  const setMarketType = usePreferencesStore((s) => s.setMarketType);
  const signal = useTokenSignal(symbol, timeframe, marketType);
  const alignment = useTimeframeAlignment(symbol, marketType);
  const perpQuery = usePerpContext(symbol, marketType);
  const perp = marketType === "perp" ? (perpQuery.data ?? null) : null;
  const sessionQuery = useSessionLevels(symbol, marketType);
  const sessionLevels = useMemo(() => sessionQuery.data ?? [], [sessionQuery.data]);
  const biasByTimeframe = new Map(
    alignment.data?.map((entry) => [entry.timeframe, entry.direction]) ?? [],
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
  const marketOutlook = useMemo(() => describeMarketOutlook(evalsByTimeframe), [evalsByTimeframe]);
  const data = signal.data;
  const live = useLivePrice(symbol, data?.source === "live", marketType);
  // `risk.entry` already anchors on the REST-fetched live price (see
  // buildRiskPlan), falling back to the last closed candle only if that fetch
  // failed — so it's a strictly better fallback than the raw candle close,
  // which reintroduces the per-timeframe staleness this is meant to avoid.
  const lastClose = live?.price ?? data?.evaluation.risk.entry ?? 0;
  const change24h = live?.change24h ?? (data ? computeChange24h(data.candles) : 0);
  const name = UNIVERSE.find((u) => u.ticker === symbol)?.name ?? symbol;
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
          <div className="flex rounded-md border border-border bg-surface p-0.5 text-xs">
            {(["spot", "perp"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMarketType(m)}
                title={m === "spot" ? "Binance spot" : "Binance USDⓈ-M perpetual futures"}
                className={cn(
                  "h-9 rounded px-3 font-semibold transition-colors",
                  marketType === m
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "spot" ? "Spot" : "Perp"}
              </button>
            ))}
          </div>
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
          <div className="flex min-h-0 flex-col gap-3">
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
            <div className="flex min-h-0 flex-col gap-3">
              <IqCard
                padded={false}
                data-tour="chart"
                className="flex flex-col overflow-hidden lg:min-h-0 lg:flex-1"
              >
                <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
                  <div className="flex items-baseline gap-3">
                    <div className="flex items-center gap-1.5">
                      <CardEyebrow>Price Structure</CardEyebrow>
                      <InfoHint text="Candlestick chart of the selected timeframe. The legend below the chart explains every overlay — click an item to hide or show it. Drag the chart past the oldest candle to load more history." />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {data.candles.length} {data.source === "live" ? "Binance" : "synthetic"} bars
                      · {data.displayPivots.length} pivots
                    </span>
                  </div>
                  <Badge variant="outline" className="border-info/30 bg-info-soft text-info">
                    {timeframe} lean:{" "}
                    {data.evaluation.direction === "none" ? "neutral" : data.evaluation.direction}
                  </Badge>
                </div>
                <div className="flex min-h-0 flex-1 flex-col lg:min-h-[240px]">
                  {data?.candles.length > 0 && (
                    <TokenChart
                      {...data}
                      symbol={symbol}
                      timeframe={timeframe}
                      market={marketType}
                      sessionLevels={sessionLevels}
                    />
                  )}
                </div>
              </IqCard>
            </div>

            <AssistantPanel
              symbol={symbol}
              assessments={assessments}
              active={activeAssessment}
              activeIntent={tradingIntent}
              marketOutlook={marketOutlook}
              perp={perp}
              sessionLevels={sessionLevels}
              price={lastClose}
              onSelect={setTradingIntent}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              className="lg:h-full lg:min-h-0"
            />
          </div>

          {/* AI analyst: on-demand, opened from the floating button below. Kept
              mounted so the chat history survives closing/reopening the drawer. */}
          <AiDrawer
            symbol={symbol}
            timeframe={timeframe}
            evaluation={data.evaluation}
            assessment={activeAssessment}
            chartStructure={chartStructure}
            open={aiOpen}
            onOpenChange={setAiOpen}
          />
          {!aiOpen && (
            <button
              type="button"
              data-tour="ai"
              onClick={() => setAiOpen(true)}
              aria-label="Open AI analyst"
              className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-lg transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <Bot className="h-5 w-5" />
              <span className="hidden sm:inline">Ask AI</span>
            </button>
          )}

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
          if (target === "ai") {
            setAiOpen(true);
            return;
          }
          // Each tour step lives on a specific tab — surface it before the
          // spotlight measures the target (ProductTour re-measures after 120ms).
          const tabForTarget: Record<string, string> = {
            objective: "decision",
            decision: "decision",
            risk: "plan",
            backtest: "evidence",
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

function TokenChart({
  symbol,
  timeframe,
  market,
  candles,
  displayPivots,
  trendLines,
  evaluation,
  source,
  liveCandle,
  sessionLevels,
}: TokenSignalData & {
  symbol: string;
  timeframe: TokenTimeframe;
  market: MarketType;
  sessionLevels: SessionLevel[];
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
  const earliestTimeRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const loadOlderRef = useRef<() => void>(() => { });

  const hiddenIndicators = usePreferencesStore((s) => s.hiddenChartIndicators);
  const toggleIndicator = usePreferencesStore((s) => s.toggleChartIndicator);

  const baseZones = useMemo(
    () => (SD_ZONE_TIMEFRAMES.includes(timeframe) ? computeBaseZones(candles) : []),
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
    const allCandles = liveCandle ? [...history, ...candles, liveCandle] : [...history, ...candles];

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

    // The default price scale (2dp, 0.01 steps) collapses sub-dollar assets:
    // DOGE's axis becomes a single label and the plan lines overlap.
    const precision = pricePrecision(validCandles.at(-1)?.close ?? 0);
    const priceFormat = { type: "price" as const, precision, minMove: 10 ** -precision };
    for (const series of [
      candleSeries,
      supportSeriesRef.current,
      resistanceSeriesRef.current,
      entrySeriesRef.current,
      stopSeriesRef.current,
      target1SeriesRef.current,
      target2SeriesRef.current,
      emaFastSeriesRef.current,
      emaSlowSeriesRef.current,
    ]) {
      series?.applyOptions({ priceFormat });
    }

    const timeScale = chart.timeScale();
    const isNewDataset = appliedKeyRef.current !== datasetKey;
    const prevRange = timeScale.getVisibleRange();
    const prevLast = lastTimeRef.current;

    candleSeries.setData(
      validCandles.map(
        (c): CandlestickData<Time> => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }),
      ),
    );
    volumeSeries.setData(
      validCandles.map(
        (c): HistogramData<Time> => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? "rgba(34,197,94,0.32)" : "rgba(244,63,94,0.32)",
        }),
      ),
    );
    const emaFastData = computeEmaSeries(validCandles, EMA_FAST.length) ?? [];
    const emaSlowData = computeEmaSeries(validCandles, EMA_SLOW.length) ?? [];
    emaFastSeriesRef.current?.setData(toLineData(emaFastData));
    emaSlowSeriesRef.current?.setData(toLineData(emaSlowData));

    // Trend lines and plan levels must be re-set in this same pass: re-setting
    // the candles rebuilds the chart's internal time index, and a line series
    // left holding points anchored to the old index crashes the renderer
    // ("Value is null") on its next repaint. Filter to only times in the chart.
    const chartStart = validCandles[0]?.time ?? 0;
    const chartEnd = validCandles.at(-1)?.time ?? Infinity;
    const validSupportData =
      trendLines?.support?.filter((p) => p && p.time >= chartStart && p.time <= chartEnd) ?? [];
    const validResistanceData =
      trendLines?.resistance?.filter((p) => p && p.time >= chartStart && p.time <= chartEnd) ?? [];
    supportSeriesRef.current?.setData(toLineData(validSupportData));
    resistanceSeriesRef.current?.setData(toLineData(validResistanceData));

    const start = candles[0]?.time;
    // Extend to the live candle (when present) so the plan lines reach the
    // actual last bar on screen instead of stopping one bar short of it.
    const end = validCandles[validCandles.length - 1]?.time;
    // Without a directional plan the entry/stop/targets all collapse onto the
    // last close — drawing them would just clutter the chart.
    const planActive = evaluation?.risk?.direction !== "none";
    const setLevel = (series: ISeriesApi<"Line"> | null, value: number) => {
      const isValid =
        planActive &&
        start &&
        end &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        Number.isFinite(value);
      series?.setData(
        isValid
          ? [
            { time: start as UTCTimestamp, value },
            { time: end as UTCTimestamp, value },
          ]
          : [],
      );
    };
    setLevel(entrySeriesRef.current, evaluation?.risk?.entry);
    setLevel(stopSeriesRef.current, evaluation?.risk?.stop);
    setLevel(target1SeriesRef.current, evaluation?.risk?.target1);
    setLevel(target2SeriesRef.current, evaluation?.risk?.target2);

    earliestTimeRef.current = validCandles[0]?.time ?? null;
    lastTimeRef.current = validCandles.at(-1)?.time ?? null;

    if (isNewDataset || prevRange === null) {
      appliedKeyRef.current = datasetKey;
      timeScale.fitContent();
    } else if (prevLast !== null && (prevRange.to as number) >= prevLast) {
      // Viewing the newest bar: stay pinned to real time as fresh bars arrive.
      timeScale.scrollToRealTime();
    } else {
      // Panned into history (or older bars just loaded): keep the same window.
      timeScale.setVisibleRange(prevRange);
    }
  }, [
    candles,
    symbol,
    timeframe,
    market,
    source,
    historyVersion,
    trendLines,
    evaluation?.risk,
    liveCandle,
  ]);

  useEffect(() => {
    const markers: SeriesMarker<Time>[] = hiddenIndicators.pivots
      ? []
      : (displayPivots || [])
        .filter((pivot) => pivot && Number.isFinite(pivot.time) && Number.isFinite(pivot.price))
        .map((pivot) => ({
          time: pivot.time as UTCTimestamp,
          position: pivot.kind === "high" ? "aboveBar" : "belowBar",
          shape: pivot.kind === "high" ? "arrowDown" : "arrowUp",
          color: pivot.kind === "high" ? "#f59e0b" : "#22c55e",
          size: 1,
        }));
    markerRef.current?.setMarkers(markers);
  }, [displayPivots, hiddenIndicators.pivots]);

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
    if (!hiddenIndicators.sdZones) zones.push(...baseZonesToPriceZones(baseZones));
    if (!hiddenIndicators.zones) zones.push(...computeSetupZones(candles, evaluation));
    zonesPrimitiveRef.current?.setZones(zones);
  }, [candles, evaluation, baseZones, hiddenIndicators.zones, hiddenIndicators.sdZones]);

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
        <div ref={hostRef} className="h-[360px] w-full sm:h-[400px] lg:h-full" />
      </div>
      <ChartLegend
        hidden={hiddenIndicators}
        planActive={evaluation.risk.direction !== "none"}
        zonesActive={hasStrongSetup(evaluation)}
        sdActive={baseZones.length > 0}
        sessionsActive={sessionLevels.length > 0 && SESSION_LINE_TIMEFRAMES.includes(timeframe)}
        onToggle={toggleIndicator}
      />
    </>
  );
}

// Zones are only drawn when the engine actually wants the trade, not when it
// merely leans a direction while telling you to wait.
function hasStrongSetup(evaluation: SignalEvaluation): boolean {
  return (
    evaluation.risk.direction !== "none" &&
    (evaluation.decision === "buy-candidate" || evaluation.decision === "short-candidate")
  );
}

function computeSetupZones(
  candles: TokenSignalData["candles"],
  evaluation: SignalEvaluation,
): PriceZone[] {
  if (!hasStrongSetup(evaluation)) return [];
  const { risk } = evaluation;
  const planStart = candles[Math.max(0, candles.length - 10)]?.time;
  if (planStart === undefined) return [];

  const long = risk.direction === "long";
  const zones: PriceZone[] = [];

  // Green-red position bands: reward up to target 1, risk down to the stop.
  zones.push({
    priceLow: Math.min(risk.entry, risk.target1),
    priceHigh: Math.max(risk.entry, risk.target1),
    from: planStart as UTCTimestamp,
    fill: "rgba(34,197,94,0.10)",
    border: "rgba(34,197,94,0.28)",
    label: "REWARD → T1",
    labelColor: "rgba(34,197,94,0.85)",
    labelAlign: long ? "top" : "bottom",
  });
  zones.push({
    priceLow: Math.min(risk.entry, risk.stop),
    priceHigh: Math.max(risk.entry, risk.stop),
    from: planStart as UTCTimestamp,
    fill: "rgba(244,63,94,0.10)",
    border: "rgba(244,63,94,0.28)",
    label: "RISK → STOP",
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
      label: "Swing points",
      hint: "Arrows mark confirmed swing points: amber ▼ above swing highs, green ▲ below swing lows. Trend lines and setups are built from these.",
      swatch: (
        <span className="flex shrink-0 items-center gap-0.5 text-[8px] leading-none">
          <span className="text-[#f59e0b]">▼</span>
          <span className="text-[#22c55e]">▲</span>
        </span>
      ),
    },
    {
      key: "plan",
      label: "Trade plan",
      hint: "The active setup's levels: entry (blue), stop (rose), target 1 (solid green), target 2 (dashed green). Shown only while the engine has a directional plan.",
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
      hint: "Shaded bands drawn only for a strong setup: green = reward to target 1, red = risk to the stop, blue = the buy/sell pocket around entry.",
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
  ];

function ChartLegend({
  hidden,
  planActive,
  zonesActive,
  sdActive,
  sessionsActive,
  onToggle,
}: {
  hidden: Partial<Record<IndicatorKey, boolean>>;
  planActive: boolean;
  zonesActive: boolean;
  sdActive: boolean;
  sessionsActive: boolean;
  onToggle: (key: IndicatorKey) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-border px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex cursor-default items-center gap-1.5 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
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
        return (
          <Tooltip key={entry.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onToggle(entry.key)}
                aria-pressed={!isHidden}
                className={cn(
                  "flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-surface",
                  isHidden ? "opacity-40 grayscale" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {entry.swatch}
                <span className={cn(isHidden && "line-through")}>{entry.label}</span>
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
  perp,
  sessionLevels,
  price,
  onSelect,
  activeTab,
  onTabChange,
  className,
}: {
  symbol: string;
  assessments: DisplayIntentAssessment[];
  active: DisplayIntentAssessment | null;
  activeIntent: TradingIntent;
  marketOutlook: string;
  perp: PerpRead | null;
  sessionLevels: SessionLevel[];
  price: number;
  onSelect: (intent: TradingIntent) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
  className?: string;
}) {
  const byIntent = new Map(assessments.map((a) => [a.intent, a]));
  const router = useRouter();
  const follow = useTrackedSignalsStore((s) => s.follow);
  const hasOpenSignal = useTrackedSignalsStore((s) => s.hasOpenSignal);
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

  const confirmFollow = () => {
    if (!active?.plan || active.direction === "none") return;
    const entryPrice = Number.parseFloat(entryPriceInput);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      toast.error("Enter a valid entry price.");
      return;
    }
    follow({
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
                ["decision", "Decision"],
                ["why", "Why"],
                ["plan", "Plan"],
                ["entry", "Entry"],
                ["context", "Context"],
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
            {/* 1 — SHOULD I TRADE? The verdict, up front. */}
            <TabsContent value="decision" className="mt-0 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold leading-tight tracking-tight">
                    {active.headline}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {`${active.definition.contextTimeframe} context · ${active.definition.executionTimeframe} trigger · holds ${active.definition.horizon}`}
                  </p>
                </div>
                <ConfidenceGauge value={active.confidence} size={60} />
              </div>

              <div
                data-tour="decision"
                className={cn("rounded-lg border p-2.5", verdictTone(active))}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Verdict · {active.definition.label}
                    <InfoHint text="'Not yet', 'reduced size', 'wrong direction', and 'unsuitable market' are all different answers. The badge names which one applies to your objective; the text explains why in plain words." />
                  </span>
                  <VerdictBadge assessment={active} />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {active.summary}
                </p>
                <HoldNote hold={active.hold} />
              </div>

              {marketOutlook && (
                <div className="rounded-lg border border-border bg-surface p-2.5">
                  <div className="flex items-center gap-1.5">
                    <CardEyebrow>Market Outlook</CardEyebrow>
                    <InfoHint text="The current market story for this token, told before any recommendation: the big picture, the near-term tape, and what that combination rewards. Every verdict below is this narrative applied to one objective." />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    {marketOutlook}
                  </p>
                </div>
              )}
            </TabsContent>

            {/* 2 — WHY? Reasoning + what would change the verdict. */}
            <TabsContent value="why" className="mt-0 space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Confirmation Checklist</CardEyebrow>
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
            </TabsContent>

            {/* 3 — RISK? The execution plan and sizing. */}
            <TabsContent value="plan" className="mt-0">
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
                    {active.verdict === "wait" && (
                      <p className="text-[10px] font-semibold leading-relaxed text-warning">
                        Conditional — execute only once the checklist above completes.
                      </p>
                    )}
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
                        label="Gain @ T1"
                        value={formatMoney(active.plan.estimatedGain1)}
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
                    {(active.verdict === "favored" || active.verdict === "caution") &&
                      active.direction !== "none" &&
                      (hasOpenSignal(symbol, active.intent, active.direction) ? (
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
                      ))}
                  </>
                ) : (
                  <p className="rounded-lg border border-border bg-surface p-2.5 text-xs leading-relaxed text-muted-foreground">
                    {planEmptyMessage(active, assessments)}
                  </p>
                )}
              </div>
            </TabsContent>

            {/* 4 — WHERE? Entry location, structure, sessions, confluence. */}
            <TabsContent value="entry" className="mt-0 space-y-3">
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

            {/* 5 — MARKET CONTEXT: regime, funding/OI, volatility. */}
            <TabsContent value="context" className="mt-0 space-y-3">
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

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Conditions · {active.definition.executionTimeframe}</CardEyebrow>
                  <InfoHint text="The market's current condition in plain words — trend, momentum, volume, volatility — with the exact ATR and volume readings below. Bigger ATR means wilder swings." />
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
            </TabsContent>

            {/* 6 — EVIDENCE: backtest + the engine's live record. */}
            <TabsContent value="evidence" className="mt-0 space-y-3">
              <div data-tour="backtest">
                <BacktestEvidence backtest={active.execution.backtest} />
              </div>

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
            </TabsContent>

            {/* 7 — DETAILS: the engine's scored checks. */}
            <TabsContent value="details" className="mt-0">
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

function VerdictBadge({ assessment }: { assessment: IntentAssessment }) {
  const { verdict, direction, isCounterTrend } = assessment;
  // The label must tell the same story as the narrative: a counter-trend
  // trade is never presented as a plain "long/short favored".
  const label =
    verdict === "favored"
      ? `${direction} favored`
      : verdict === "caution"
        ? isCounterTrend
          ? `counter-trend ${direction} · ½ size`
          : `tactical ${direction} · ½ size`
        : verdict === "wait"
          ? isCounterTrend
            ? `counter-trend ${direction} · not yet`
            : "not yet"
          : "stand aside";
  return (
    <Badge
      variant="outline"
      className={cn(
        "capitalize",
        verdict === "favored" &&
        (direction === "short"
          ? "border-bearish/30 bg-bearish-soft text-bearish"
          : "border-bullish/30 bg-bullish-soft text-bullish"),
        verdict === "caution" && "border-warning/30 bg-warning-soft text-warning",
        verdict === "wait" && "border-info/30 bg-info-soft text-info",
        verdict === "avoid" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {label}
    </Badge>
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

// When there is nothing to execute for the chosen objective, say what would
// pay instead — "no trade" should read as "wrong objective", not "go away".
function planEmptyMessage(active: IntentAssessment, assessments: IntentAssessment[]): string {
  const alt = assessments.find(
    (a) =>
      a.intent !== active.intent &&
      (a.verdict === "favored" || a.verdict === "caution") &&
      a.plan !== null,
  );
  const base =
    active.verdict === "wait"
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

  const atr = a.atrPercent ?? 0;
  const volatility: InsightRow =
    atr < 2.2
      ? { label: "Volatility (ATR)", value: "Low", tone: "neutral", dir: "flat" }
      : atr < 4.5
        ? { label: "Volatility (ATR)", value: "Medium", tone: "warning", dir: "flat" }
        : { label: "Volatility (ATR)", value: "High", tone: "bearish", dir: "up" };

  return [trend, momentum, volume, volatility];
}

function KeyInsightBox({ label, value, tone, dir }: InsightRow) {
  const DirIcon = dir === "up" ? TrendingUp : dir === "down" ? TrendingDown : MoveRight;
  return (
    <div className="rounded-lg border border-border bg-surface p-2">
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

function BacktestEvidence({ backtest }: { backtest: SignalEvaluation["backtest"] }) {
  if (backtest.totalTrades === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3 text-xs text-muted-foreground">
        No historical {backtest.strategyName.toLowerCase()} signals fired in this window — no
        backtest evidence either way.
      </div>
    );
  }
  const positive = backtest.expectancy > 0;
  // With too few replayed trades, win rate/expectancy are noise — don't color
  // them as if they were a verdict, and say so explicitly.
  const lowSample = backtest.lowSample;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <CardEyebrow>Backtest Evidence</CardEyebrow>
          <InfoHint text="A replay of this exact setup type on this chart's history. Win rate = how often it worked; expectancy = the average result per trade in R (1R = the amount you risk); max DD = the worst losing stretch." />
        </div>
        <span className="truncate text-[9px] uppercase tracking-wider text-muted-foreground">
          {backtest.strategyName} · this token, this timeframe
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <RiskMetric label="Trades" value={String(backtest.totalTrades)} compact />
        <RiskMetric
          label="Win rate"
          value={`${backtest.winRate}%`}
          tone={lowSample ? undefined : backtest.winRate >= 50 ? "bullish" : "bearish"}
          compact
        />
        <RiskMetric
          label="Expectancy"
          value={`${backtest.expectancy >= 0 ? "+" : ""}${backtest.expectancy}R`}
          tone={lowSample ? undefined : positive ? "bullish" : "bearish"}
          compact
        />
        <RiskMetric label="Profit factor" value={String(backtest.profitFactor)} compact />
        <RiskMetric label="Avg R" value={`${backtest.averageR}R`} compact />
        <RiskMetric label="Max DD" value={`${backtest.maxDrawdown}R`} tone="bearish" compact />
      </div>
      {lowSample ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Only {backtest.totalTrades} historical {backtest.strategyName.toLowerCase()} trade
          {backtest.totalTrades === 1 ? "" : "s"} on this chart — too few to trust as a statistic.
          Treat this as a hint, not a verdict.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {positive
            ? `Similar ${backtest.strategyName.toLowerCase()} signals on this chart carried positive expectancy — historical support for acting when the engine confirms.`
            : `Similar ${backtest.strategyName.toLowerCase()} signals on this chart lost money historically — demand extra confirmation before acting.`}
        </p>
      )}
    </div>
  );
}

const SUGGESTED_PROMPTS = [
  "Summarize this setup in plain words.",
  "What would invalidate this setup?",
  "Critique the risk/reward and position sizing.",
] as const;

function AiDrawer({
  symbol,
  timeframe,
  evaluation,
  assessment,
  chartStructure,
  open,
  onOpenChange,
}: {
  symbol: string;
  timeframe: TokenTimeframe;
  evaluation: SignalEvaluation;
  assessment: IntentAssessment | null;
  chartStructure: ChartStructure | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [thinkingMode, setThinkingMode] = useState(true);
  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState<
    Array<{ role: "user" | "assistant"; text: string; source?: string }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const runAnalysis = useCallback(
    async (ask?: string) => {
      const fallback = () =>
        deterministicFallback({
          symbol,
          range: timeframe,
          evaluation,
          assessment,
          question: ask,
          thinkingMode,
        });

      // No key configured — deterministic memo, exactly as before.
      if (!aiConfig) {
        setChat((items) =>
          [
            ...items,
            ...(ask ? [{ role: "user" as const, text: ask }] : []),
            { role: "assistant" as const, text: fallback(), source: "deterministic fallback" },
          ].slice(-10),
        );
        setQuestion("");
        return;
      }

      const priorForModel = chat;
      setChat((items) =>
        [...items, ...(ask ? [{ role: "user" as const, text: ask }] : [])].slice(-10),
      );
      setQuestion("");
      setLoading(true);
      setError(null);
      try {
        const system = buildAnalystSystem(
          symbol,
          timeframe,
          evaluation,
          assessment,
          thinkingMode,
          chartStructure,
        );
        // Replay prior turns, but drop any leading assistant memos so the
        // history starts with a user turn (required by the Anthropic API).
        const history = priorForModel.reduce<AiMessage[]>((acc, m) => {
          if (acc.length === 0 && m.role !== "user") return acc;
          return [...acc, { role: m.role, content: m.text }];
        }, []);
        const messages: AiMessage[] = [
          ...history,
          { role: "user", content: ask ?? MEMO_INSTRUCTION },
        ];
        const text = await runAiAnalyst({ config: aiConfig, system, messages });
        setChat((items) =>
          [...items, { role: "assistant" as const, text, source: aiConfig.model }].slice(-10),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed.");
        setChat((items) =>
          [
            ...items,
            { role: "assistant" as const, text: fallback(), source: "deterministic fallback" },
          ].slice(-10),
        );
      } finally {
        setLoading(false);
      }
    },
    [aiConfig, chat, evaluation, assessment, chartStructure, symbol, timeframe, thinkingMode],
  );

  // On-demand drawer, opened from the floating button on the token page. The
  // component stays mounted while closed so chat history survives reopening.
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2 pr-10">
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="h-4 w-4 shrink-0 text-info" />
            <SheetTitle className="truncate text-xs font-bold">AI Analyst</SheetTitle>
            <InfoHint text="A second read on the setup: it cross-checks the engine's plan against the chart's demand/supply zones, support/resistance levels and volume, and will flag conflicts. It only uses the data on this page — no outside market feed." />
          </div>
          <label className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
            <Brain className="h-3.5 w-3.5" />
            <Switch checked={thinkingMode} onCheckedChange={setThinkingMode} />
          </label>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
          <div className="grid shrink-0 grid-cols-3 gap-1.5">
            <ContextPill label="Signal" value={`${evaluation.confidence}/100`} />
            <ContextPill label="Regime" value={evaluation.regime.replaceAll("-", " ")} />
            <ContextPill label="Source" value={aiConfig ? aiConfig.model : "fallback"} />
          </div>

          {!aiConfig && (
            <Link
              to="/settings"
              className="shrink-0 rounded-md border border-info/30 bg-info-soft px-2.5 py-1.5 text-[11px] leading-snug text-info transition-colors hover:bg-info/20"
            >
              Using the built-in deterministic analyst. Add your own API key in Settings for
              AI-written analysis.
            </Link>
          )}

          <div className="min-h-[160px] flex-1 overflow-y-auto rounded-lg border border-border bg-surface p-3 lg:min-h-0">
            {chat.length === 0 && !loading ? (
              <div className="flex h-full min-h-[130px] flex-col justify-center gap-1.5">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Bot className="h-4 w-4 text-info" />
                  Ask the analyst about this setup
                </div>
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => runAnalysis(prompt)}
                    className="rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-info/40 hover:text-foreground"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {chat.map((item, index) => (
                  <div
                    key={`${item.role}-${index}`}
                    className={cn(
                      "rounded-lg border p-3 text-sm",
                      item.role === "assistant"
                        ? "border-info/20 bg-background"
                        : "ml-8 border-border bg-card text-muted-foreground",
                    )}
                  >
                    <div className="mb-2 truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {item.role === "assistant" ? (item.source ?? "assistant") : "you"}
                    </div>
                    {item.role === "assistant" ? (
                      <MarkdownText text={item.text} />
                    ) : (
                      <p>{item.text}</p>
                    )}
                  </div>
                ))}
                {loading && (
                  <div className="flex items-center gap-2 rounded-lg border border-info/20 bg-background p-3 text-sm text-muted-foreground">
                    <span className="h-3 w-3 animate-spin rounded-full border border-info border-t-transparent" />
                    Analyzing with {aiConfig?.model ?? "the model"}…
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="shrink-0 rounded-md border border-bearish/30 bg-bearish-soft px-2.5 py-1.5 text-[11px] leading-snug text-bearish">
              {error} Showing the deterministic memo instead.
            </div>
          )}

          <div className="grid shrink-0 grid-cols-3 gap-1.5 lg:grid-cols-1">
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={loading}
              onClick={() => runAnalysis()}
            >
              <Play className="h-3.5 w-3.5" />
              Run analysis
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={loading}
              onClick={() => runAnalysis("What would invalidate this setup?")}
            >
              Invalidation
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={loading}
              onClick={() => runAnalysis("Critique the risk/reward and position sizing.")}
            >
              Risk check
            </Button>
          </div>

          <form
            className="flex shrink-0 gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const ask = question.trim();
              if (ask) runAnalysis(ask);
            }}
          >
            <Textarea
              value={question}
              onChange={(event) => setQuestion(event.currentTarget.value)}
              placeholder="Ask about this setup..."
              className="min-h-9 flex-1 resize-none text-sm"
              rows={1}
            />
            <Button
              type="submit"
              size="icon"
              className="h-9 w-9 shrink-0"
              disabled={loading || question.trim().length === 0}
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function deterministicFallback(req: {
  symbol: string;
  range: string;
  evaluation: SignalEvaluation;
  assessment?: IntentAssessment | null;
  question?: string;
  thinkingMode: boolean;
}): string {
  const e = req.evaluation;
  const lines = [
    `### Quant memo: ${req.assessment ? req.assessment.headline : e.decision.replaceAll("-", " ")}`,
    ``,
    ...(req.assessment
      ? [`- **Your objective (${req.assessment.definition.label}):** ${req.assessment.summary}`]
      : []),
    `- **Setup:** ${e.setupType.replaceAll("-", " ")}`,
    `- **Regime:** ${e.regime.replaceAll("-", " ")}`,
    `- **Confidence:** ${e.confidence}/100`,
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

function MarkdownText({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(<ul key={`ul-${blocks.length}`}>{list}</ul>);
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      blocks.push(<h4 key={`h-${blocks.length}`}>{renderInline(line.slice(4))}</h4>);
    } else if (line.startsWith("## ")) {
      flushList();
      blocks.push(<h4 key={`h-${blocks.length}`}>{renderInline(line.slice(3))}</h4>);
    } else if (line.startsWith("- ")) {
      list.push(<li key={`li-${blocks.length}-${list.length}`}>{renderInline(line.slice(2))}</li>);
    } else if (/^\d+\.\s/.test(line)) {
      list.push(
        <li key={`li-${blocks.length}-${list.length}`}>
          {renderInline(line.replace(/^\d+\.\s/, ""))}
        </li>,
      );
    } else {
      flushList();
      blocks.push(<p key={`p-${blocks.length}`}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return (
    <div className="space-y-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_h4]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-foreground">
      {blocks}
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
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

function ContextPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-2">
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
