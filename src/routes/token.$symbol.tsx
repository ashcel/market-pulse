import { createFileRoute } from "@tanstack/react-router";
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
  ISeriesApi,
  ISeriesMarkersPluginApi,
  LineData,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import {
  Bot,
  Brain,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Play,
  Send,
  ShieldAlert,
} from "lucide-react";

import { Link } from "@tanstack/react-router";

import { AssetIcon } from "@/components/iq/asset-icon";
import { Change } from "@/components/iq/change";
import { ConfidenceGauge } from "@/components/iq/confidence-gauge";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { MiniChart } from "@/components/iq/mini-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTokenSignal, type TokenSignalData } from "@/hooks/useTokenSignal";
import { UNIVERSE } from "@/lib/engine/market";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { SignalEvaluation, SignalStatus } from "@/lib/engine/quant";
import { usePreferencesStore } from "@/stores/preferences";
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
  component: TokenDetailPage,
});

const TIMEFRAMES: TokenTimeframe[] = ["1H", "4H", "1D", "1W"];

function TokenDetailPage() {
  const { symbol: rawSymbol } = Route.useParams();
  const symbol = rawSymbol.toUpperCase();
  const [timeframe, setTimeframe] = useState<TokenTimeframe>("4H");
  const signal = useTokenSignal(symbol, timeframe);
  const data = signal.data;
  const live = useLivePrice(symbol, data?.source === "live");
  const lastClose =
    live?.price ?? data?.candles.at(-1)?.close ?? data?.evaluation.analytics.lastClose ?? 0;
  const change24h = live?.change24h ?? (data ? computeChange24h(data.candles) : 0);
  const name = UNIVERSE.find((u) => u.ticker === symbol)?.name ?? symbol;
  const stats = useMemo(() => (data ? compute24hStats(data.candles) : null), [data]);
  const spark = useMemo(
    () => data?.candles.slice(-32).map((c, i) => ({ t: i, v: c.close })) ?? [],
    [data],
  );

  return (
    // Locked to the viewport on desktop: only the right panel and chat scroll.
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 lg:h-[calc(100dvh-7rem)] lg:min-h-0">
      <IqCard
        padded={false}
        className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <AssetIcon ticker={symbol} className="h-8 w-8 text-sm" />
          <div className="leading-tight">
            <h1 className="text-lg font-bold tracking-tight">{symbol}</h1>
            <div className="text-[11px] text-muted-foreground">{name} / USDT</div>
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
          <div className="grid grid-cols-4 rounded-md border border-border bg-surface p-0.5 text-xs">
            {TIMEFRAMES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTimeframe(item)}
                className={cn(
                  "h-7 rounded px-2.5 font-semibold transition-colors",
                  timeframe === item
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
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
        </div>
      </IqCard>

      {signal.isLoading || !data ? (
        <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,25rem)]">
          <div className="flex min-h-0 flex-col gap-3">
            <IqCard padded={false} className="overflow-hidden lg:min-h-0 lg:flex-[13]">
              <div className="h-[360px] animate-pulse bg-surface lg:h-full" />
            </IqCard>
            <IqCard className="h-64 animate-pulse bg-surface lg:h-auto lg:min-h-0 lg:flex-[10]" />
          </div>
          <IqCard className="h-96 animate-pulse bg-surface lg:h-full" />
        </div>
      ) : (
        <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,25rem)]">
          <div className="flex min-h-0 flex-col gap-3">
            <IqCard
              padded={false}
              className="flex flex-col overflow-hidden lg:min-h-0 lg:flex-[13]"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
                <div className="flex items-baseline gap-3">
                  <CardEyebrow>Price Structure</CardEyebrow>
                  <span className="text-xs text-muted-foreground">
                    {data.candles.length} {data.source === "live" ? "Binance" : "synthetic"} bars ·{" "}
                    {data.pivots.length} pivots
                  </span>
                </div>
                <Badge variant="outline" className="border-info/30 bg-info-soft text-info">
                  {data.evaluation.decision.replaceAll("-", " ")}
                </Badge>
              </div>
              <div className="min-h-0 flex-1 lg:min-h-[240px]">
                <TokenChart {...data} />
              </div>
            </IqCard>

            <QuantAiPanel
              symbol={symbol}
              timeframe={timeframe}
              evaluation={data.evaluation}
              className="lg:min-h-0 lg:flex-[10]"
            />
          </div>

          <SignalPanel
            evaluation={data.evaluation}
            className="lg:h-full lg:min-h-0 lg:overflow-y-auto"
          />
        </div>
      )}
    </div>
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

function TokenChart({ candles, pivots, trendLines, evaluation }: TokenSignalData) {
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
  const markerRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

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
    markerRef.current = createSeriesMarkers(candleSeries);

    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1].contentRect;
      if (rect.width > 0 && rect.height > 0) {
        chart.applyOptions({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
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
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    candleSeries.setData(
      candles.map(
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
      candles.map(
        (c): HistogramData<Time> => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? "rgba(34,197,94,0.32)" : "rgba(244,63,94,0.32)",
        }),
      ),
    );
    chart.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    supportSeriesRef.current?.setData(toLineData(trendLines.support));
    resistanceSeriesRef.current?.setData(toLineData(trendLines.resistance));
  }, [trendLines]);

  useEffect(() => {
    const start = candles[0]?.time;
    const end = candles[candles.length - 1]?.time;
    // Without a directional plan the entry/stop/targets all collapse onto the
    // last close — drawing them would just clutter the chart.
    const active = evaluation.risk.direction !== "none";
    const setLevel = (series: ISeriesApi<"Line"> | null, value: number) => {
      series?.setData(
        active && start && end
          ? [
              { time: start as UTCTimestamp, value },
              { time: end as UTCTimestamp, value },
            ]
          : [],
      );
    };
    setLevel(entrySeriesRef.current, evaluation.risk.entry);
    setLevel(stopSeriesRef.current, evaluation.risk.stop);
    setLevel(target1SeriesRef.current, evaluation.risk.target1);
    setLevel(target2SeriesRef.current, evaluation.risk.target2);
  }, [candles, evaluation.risk]);

  useEffect(() => {
    const markers: SeriesMarker<Time>[] = pivots.map((pivot) => ({
      time: pivot.time as UTCTimestamp,
      position: pivot.kind === "high" ? "aboveBar" : "belowBar",
      shape: pivot.kind === "high" ? "arrowDown" : "arrowUp",
      color: pivot.kind === "high" ? "#f59e0b" : "#22c55e",
      size: 1,
    }));
    markerRef.current?.setMarkers(markers);
  }, [pivots]);

  return <div ref={hostRef} className="h-[360px] w-full sm:h-[400px] lg:h-full" />;
}

function toLineData(points: Array<{ time: number; value: number }>): LineData<Time>[] {
  return points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
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

function SignalPanel({
  evaluation,
  className,
}: {
  evaluation: SignalEvaluation;
  className?: string;
}) {
  const decisionTone =
    evaluation.decision === "buy-candidate"
      ? "border-bullish/30 bg-bullish-soft"
      : evaluation.decision === "short-candidate" || evaluation.decision === "invalidated"
        ? "border-bearish/30 bg-bearish-soft"
        : "border-warning/30 bg-warning-soft";

  return (
    <IqCard padded={false} className={cn("flex flex-col gap-3.5 p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardEyebrow>Signal Engine</CardEyebrow>
          <h2 className="mt-1.5 text-lg font-semibold capitalize leading-tight tracking-tight">
            {evaluation.setupType.replaceAll("-", " ")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground capitalize">
            {evaluation.regime.replaceAll("-", " ")} · {evaluation.direction}
          </p>
        </div>
        <ConfidenceGauge value={evaluation.confidence} size={60} label="Score" />
      </div>

      <div className={cn("rounded-lg border p-3", decisionTone)}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Decision
          </span>
          <DecisionBadge decision={evaluation.decision} />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{evaluation.reason}</p>
      </div>

      {evaluation.direction !== "none" && (
        <div className="grid grid-cols-2 gap-1.5">
          <RiskMetric label="Entry" value={formatMoney(evaluation.risk.entry)} />
          <RiskMetric label="Stop" value={formatMoney(evaluation.risk.stop)} tone="bearish" />
          <RiskMetric
            label="Target 1"
            value={formatMoney(evaluation.risk.target1)}
            tone="bullish"
          />
          <RiskMetric
            label="Target 2"
            value={formatMoney(evaluation.risk.target2)}
            tone="bullish"
          />
          <RiskMetric
            label="Position"
            value={`${formatUnits(evaluation.risk.positionSize)} ≈ ${formatMoney(evaluation.risk.positionSize * evaluation.risk.entry)}`}
          />
          <RiskMetric
            label="R/R"
            value={`${evaluation.risk.rewardRisk1}R / ${evaluation.risk.rewardRisk2}R`}
          />
          <RiskMetric
            label="Max loss"
            value={formatMoney(evaluation.risk.maxDollarLoss)}
            tone="bearish"
          />
          <RiskMetric
            label="Gain @ T1"
            value={formatMoney(evaluation.risk.estimatedGain1)}
            tone="bullish"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <CardEyebrow>Key Levels</CardEyebrow>
        <div className="grid grid-cols-2 gap-1.5 xl:grid-cols-4">
          <RiskMetric
            label="Support"
            value={formatMoney(evaluation.analytics.support)}
            tone="bullish"
            compact
          />
          <RiskMetric
            label="Resistance"
            value={formatMoney(evaluation.analytics.resistance)}
            tone="bearish"
            compact
          />
          <RiskMetric
            label="ATR (14)"
            value={
              evaluation.analytics.atrPercent !== null
                ? `${evaluation.analytics.atrPercent}%`
                : "n/a"
            }
            compact
          />
          <RiskMetric
            label="Vol vs 20-bar"
            value={
              evaluation.analytics.volumeRatio !== null
                ? `${evaluation.analytics.volumeRatio}×`
                : "n/a"
            }
            compact
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <CardEyebrow>Components</CardEyebrow>
        <div className="space-y-1.5">
          {evaluation.components.map((component) => (
            <div
              key={component.name}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
              title={component.explanation}
            >
              <StatusIcon status={component.status} />
              <span className="whitespace-nowrap text-xs font-semibold">{component.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                {component.explanation}
              </span>
              <StatusBadge status={component.status} score={component.score} />
            </div>
          ))}
        </div>
      </div>

      {evaluation.noTradeReasons.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-xs">
          <div className="mb-1.5 flex items-center gap-2 font-semibold text-warning">
            <ShieldAlert className="h-3.5 w-3.5" />
            No-trade blockers
          </div>
          <ul className="space-y-0.5 text-muted-foreground">
            {evaluation.noTradeReasons.slice(0, 4).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <BacktestEvidence backtest={evaluation.backtest} />
    </IqCard>
  );
}

function BacktestEvidence({ backtest }: { backtest: SignalEvaluation["backtest"] }) {
  if (backtest.totalTrades === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3 text-xs text-muted-foreground">
        No historical breakout signals fired in this window — no backtest evidence either way.
      </div>
    );
  }
  const positive = backtest.expectancy > 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <CardEyebrow>Backtest Evidence</CardEyebrow>
        <span className="truncate text-[9px] uppercase tracking-wider text-muted-foreground">
          {backtest.strategyName} · this token, this timeframe
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 xl:grid-cols-6">
        <RiskMetric label="Trades" value={String(backtest.totalTrades)} compact />
        <RiskMetric
          label="Win rate"
          value={`${backtest.winRate}%`}
          tone={backtest.winRate >= 50 ? "bullish" : "bearish"}
          compact
        />
        <RiskMetric
          label="Expectancy"
          value={`${backtest.expectancy >= 0 ? "+" : ""}${backtest.expectancy}R`}
          tone={positive ? "bullish" : "bearish"}
          compact
        />
        <RiskMetric label="Profit factor" value={String(backtest.profitFactor)} compact />
        <RiskMetric label="Avg R" value={`${backtest.averageR}R`} compact />
        <RiskMetric label="Max DD" value={`${backtest.maxDrawdown}R`} tone="bearish" compact />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {positive
          ? "Similar breakout signals on this chart carried positive expectancy — historical support for acting when the engine confirms."
          : "Similar breakout signals on this chart lost money historically — demand extra confirmation before acting."}
      </p>
    </div>
  );
}

type PanelTab = "analyst" | "backtest" | "risk";

const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: "analyst", label: "Analyst Panel" },
  { id: "backtest", label: "Backtest" },
  { id: "risk", label: "Risk Check" },
];

function QuantAiPanel({
  symbol,
  timeframe,
  evaluation,
  className,
}: {
  symbol: string;
  timeframe: TokenTimeframe;
  evaluation: SignalEvaluation;
  className?: string;
}) {
  const [tab, setTab] = useState<PanelTab>("analyst");
  const [thinkingMode, setThinkingMode] = useState(true);
  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);

  const runAnalysis = useCallback(
    (ask?: string) => {
      const answer = deterministicFallback({
        symbol,
        range: timeframe,
        evaluation,
        question: ask,
        thinkingMode,
      });
      setChat((items) =>
        [
          ...items,
          ...(ask ? [{ role: "user" as const, text: ask }] : []),
          { role: "assistant" as const, text: answer },
        ].slice(-10),
      );
      setQuestion("");
      setTab("analyst");
    },
    [evaluation, symbol, timeframe, thinkingMode],
  );

  return (
    <IqCard padded={false} className={cn("flex flex-col overflow-hidden", className)}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="flex items-center">
          {PANEL_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                tab === item.id
                  ? "border-info text-info"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Brain className="h-4 w-4" />
          Thinking
          <Switch checked={thinkingMode} onCheckedChange={setThinkingMode} />
        </label>
      </div>

      {tab === "analyst" && (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
          <div className="grid shrink-0 grid-cols-3 gap-1.5">
            <ContextPill label="Signal" value={`${evaluation.confidence}/100`} />
            <ContextPill label="Regime" value={evaluation.regime.replaceAll("-", " ")} />
            <ContextPill label="Source" value="fallback" />
          </div>

          <div className="min-h-[160px] flex-1 overflow-y-auto rounded-lg border border-border bg-surface p-3 lg:min-h-0">
            {chat.length === 0 ? (
              <div className="flex h-full min-h-[130px] items-center justify-center gap-2 text-sm text-muted-foreground">
                <Bot className="h-4 w-4" />
                No memo generated yet.
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
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {item.role === "assistant" ? "deterministic fallback" : "you"}
                    </div>
                    {item.role === "assistant" ? (
                      <MarkdownText text={item.text} />
                    ) : (
                      <p>{item.text}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid shrink-0 grid-cols-3 gap-1.5">
            <Button type="button" size="sm" className="h-8" onClick={() => runAnalysis()}>
              <Play className="h-3.5 w-3.5" />
              Run analysis
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => runAnalysis("What would invalidate this setup?")}
            >
              Invalidation
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
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
              disabled={question.trim().length === 0}
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}

      {tab === "backtest" && <BacktestTab backtest={evaluation.backtest} />}
      {tab === "risk" && <RiskTab evaluation={evaluation} />}
    </IqCard>
  );
}

function BacktestTab({ backtest }: { backtest: SignalEvaluation["backtest"] }) {
  return (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-semibold">{backtest.strategyName}</div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {backtest.strategyVersion} · this token, this timeframe
        </span>
      </div>
      {backtest.totalTrades === 0 ? (
        <p className="text-sm text-muted-foreground">
          No historical signals fired in this window — no backtest evidence either way.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
            <RiskMetric label="Trades" value={String(backtest.totalTrades)} compact />
            <RiskMetric
              label="Win rate"
              value={`${backtest.winRate}%`}
              tone={backtest.winRate >= 50 ? "bullish" : "bearish"}
              compact
            />
            <RiskMetric
              label="Expectancy"
              value={`${backtest.expectancy >= 0 ? "+" : ""}${backtest.expectancy}R`}
              tone={backtest.expectancy > 0 ? "bullish" : "bearish"}
              compact
            />
            <RiskMetric label="Profit factor" value={String(backtest.profitFactor)} compact />
            <RiskMetric label="Avg win" value={`${backtest.averageWin}R`} tone="bullish" compact />
            <RiskMetric
              label="Avg loss"
              value={`${backtest.averageLoss}R`}
              tone="bearish"
              compact
            />
            <RiskMetric label="Avg R" value={`${backtest.averageR}R`} compact />
            <RiskMetric label="Max DD" value={`${backtest.maxDrawdown}R`} tone="bearish" compact />
            <RiskMetric
              label="Best trade"
              value={`${backtest.bestTradeR}R`}
              tone="bullish"
              compact
            />
            <RiskMetric
              label="Worst trade"
              value={`${backtest.worstTradeR}R`}
              tone="bearish"
              compact
            />
            <RiskMetric label="Max win streak" value={String(backtest.consecutiveWins)} compact />
            <RiskMetric
              label="Max loss streak"
              value={String(backtest.consecutiveLosses)}
              compact
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Walk-forward replay of the breakout strategy on the loaded bars. Past performance on
            this chart is evidence, not a guarantee.
          </p>
        </>
      )}
    </div>
  );
}

function RiskTab({ evaluation }: { evaluation: SignalEvaluation }) {
  const risk = usePreferencesStore((s) => s.risk);
  return (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <RiskMetric label="Direction" value={evaluation.direction} compact />
        <RiskMetric label="Entry" value={formatMoney(evaluation.risk.entry)} compact />
        <RiskMetric label="Stop" value={formatMoney(evaluation.risk.stop)} tone="bearish" compact />
        <RiskMetric
          label="Invalidation"
          value={formatMoney(evaluation.risk.invalidation)}
          tone="bearish"
          compact
        />
        <RiskMetric label="Risk / unit" value={formatMoney(evaluation.risk.riskPerUnit)} compact />
        <RiskMetric label="Position" value={formatUnits(evaluation.risk.positionSize)} compact />
        <RiskMetric
          label="Notional"
          value={formatMoney(evaluation.risk.positionSize * evaluation.risk.entry)}
          compact
        />
        <RiskMetric
          label="Max $ risk"
          value={formatMoney(evaluation.risk.maxDollarRisk)}
          tone="bearish"
          compact
        />
      </div>
      <p className="rounded-lg border border-border bg-surface p-3 text-[11px] leading-relaxed text-muted-foreground">
        Sized from your Trade Risk settings — ${risk.accountSize.toLocaleString()} account,{" "}
        {risk.maxRiskPerTradePercent}% per trade, {risk.stopMethod.replaceAll("-", " ")} stop,
        minimum {risk.minimumRewardRisk}R.{" "}
        <Link to="/settings" className="font-semibold text-info hover:underline">
          Adjust in Settings →
        </Link>
      </p>
    </div>
  );
}

function deterministicFallback(req: {
  symbol: string;
  range: string;
  evaluation: SignalEvaluation;
  question?: string;
  thinkingMode: boolean;
}): string {
  const e = req.evaluation;
  const lines = [
    `### Quant memo: ${e.decision.replaceAll("-", " ")}`,
    ``,
    `- **Setup:** ${e.setupType.replaceAll("-", " ")}`,
    `- **Regime:** ${e.regime.replaceAll("-", " ")}`,
    `- **Confidence:** ${e.confidence}/100`,
    `- **Risk plan:** entry \`${e.risk.entry}\`, stop \`${e.risk.stop}\`, target 1 \`${e.risk.target1}\`, target 2 \`${e.risk.target2}\``,
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

function DecisionBadge({ decision }: { decision: SignalEvaluation["decision"] }) {
  const bullish = decision === "buy-candidate";
  const bearish = decision === "short-candidate" || decision === "invalidated";
  return (
    <Badge
      variant="outline"
      className={cn(
        "capitalize",
        bullish && "border-bullish/30 bg-bullish-soft text-bullish",
        bearish && "border-bearish/30 bg-bearish-soft text-bearish",
        !bullish && !bearish && "border-warning/30 bg-warning-soft text-warning",
      )}
    >
      {decision.replaceAll("-", " ")}
    </Badge>
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

function formatUnits(value: number) {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 1000) {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: value >= 10 ? 3 : 5 })}`;
}
