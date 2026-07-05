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

import { Change } from "@/components/iq/change";
import { ConfidenceGauge } from "@/components/iq/confidence-gauge";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTokenSignal, type TokenSignalData } from "@/hooks/useTokenSignal";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { SignalEvaluation, SignalStatus } from "@/lib/engine/quant";
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

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 sm:gap-5">
      <header className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
        <div className="min-w-0">
          <CardEyebrow>Token Detail</CardEyebrow>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">{symbol}</h1>
            {signal.isLoading ? (
              <span className="h-6 w-28 animate-pulse rounded bg-muted" />
            ) : (
              <>
                <span className="num text-xl text-muted-foreground">{formatMoney(lastClose)}</span>
                <Change value={change24h} showIcon />
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
                      Streaming
                    </span>
                  ) : data?.source === "live" ? (
                    "Live"
                  ) : (
                    "Demo"
                  )}
                </Badge>
              </>
            )}
          </div>
        </div>
        <div className="grid grid-cols-4 rounded-md border border-border bg-surface p-1 text-xs">
          {TIMEFRAMES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTimeframe(item)}
              className={cn(
                "h-8 rounded px-3 font-semibold transition-colors",
                timeframe === item
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </header>

      {signal.isLoading || !data ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)] lg:items-start">
          <IqCard padded={false} className="overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <div className="h-3 w-28 animate-pulse rounded bg-muted" />
              <div className="mt-3 h-4 w-44 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-[360px] animate-pulse bg-surface sm:h-[400px] lg:h-[520px]" />
          </IqCard>
          <div className="flex flex-col gap-4">
            <IqCard className="h-72 animate-pulse bg-surface" />
            <IqCard className="h-96 animate-pulse bg-surface" />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)] lg:items-start">
          <IqCard padded={false} className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <CardEyebrow>Price Structure</CardEyebrow>
                <div className="mt-1 text-sm text-muted-foreground">
                  {data.candles.length} {data.source === "live" ? "Binance" : "synthetic"} bars ·{" "}
                  {data.pivots.length} pivots
                </div>
              </div>
              <Badge variant="outline" className="border-info/30 bg-info-soft text-info">
                {data.evaluation.decision.replaceAll("-", " ")}
              </Badge>
            </div>
            <TokenChart {...data} />
          </IqCard>

          <div className="flex flex-col gap-4">
            <SignalPanel evaluation={data.evaluation} />
            <QuantAiPanel symbol={symbol} timeframe={timeframe} evaluation={data.evaluation} />
          </div>
        </div>
      )}
    </div>
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

  return <div ref={hostRef} className="h-[360px] w-full sm:h-[400px] lg:h-[520px]" />;
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

function SignalPanel({ evaluation }: { evaluation: SignalEvaluation }) {
  return (
    <IqCard className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <CardEyebrow>Signal Engine</CardEyebrow>
          <h2 className="mt-2 text-xl font-semibold capitalize tracking-tight">
            {evaluation.setupType.replaceAll("-", " ")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground capitalize">
            {evaluation.regime.replaceAll("-", " ")} · {evaluation.direction}
          </p>
        </div>
        <ConfidenceGauge value={evaluation.confidence} size={82} label="Score" />
      </div>

      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Decision
          </span>
          <DecisionBadge decision={evaluation.decision} />
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{evaluation.reason}</p>
      </div>

      {evaluation.direction !== "none" && (
        <div className="grid grid-cols-2 gap-2">
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

      <div className="space-y-2">
        <CardEyebrow>Key Levels</CardEyebrow>
        <div className="grid grid-cols-2 gap-2">
          <RiskMetric
            label="Support"
            value={formatMoney(evaluation.analytics.support)}
            tone="bullish"
          />
          <RiskMetric
            label="Resistance"
            value={formatMoney(evaluation.analytics.resistance)}
            tone="bearish"
          />
          <RiskMetric
            label="ATR (14)"
            value={
              evaluation.analytics.atrPercent !== null
                ? `${evaluation.analytics.atrPercent}%`
                : "n/a"
            }
          />
          <RiskMetric
            label="Volume vs 20-bar"
            value={
              evaluation.analytics.volumeRatio !== null
                ? `${evaluation.analytics.volumeRatio}×`
                : "n/a"
            }
          />
        </div>
      </div>

      <div className="space-y-2">
        <CardEyebrow>Components</CardEyebrow>
        <div className="space-y-2">
          {evaluation.components.map((component) => (
            <div key={component.name} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <StatusIcon status={component.status} />
                  <span className="truncate text-sm font-semibold">{component.name}</span>
                </div>
                <StatusBadge status={component.status} score={component.score} />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {component.explanation}
              </p>
            </div>
          ))}
        </div>
      </div>

      {evaluation.noTradeReasons.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm">
          <div className="mb-2 flex items-center gap-2 font-semibold text-warning">
            <ShieldAlert className="h-4 w-4" />
            No-trade blockers
          </div>
          <ul className="space-y-1 text-muted-foreground">
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <CardEyebrow>Backtest Evidence</CardEyebrow>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {backtest.strategyName} · this token, this timeframe
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <RiskMetric label="Trades" value={String(backtest.totalTrades)} />
        <RiskMetric
          label="Win rate"
          value={`${backtest.winRate}%`}
          tone={backtest.winRate >= 50 ? "bullish" : "bearish"}
        />
        <RiskMetric
          label="Expectancy"
          value={`${backtest.expectancy >= 0 ? "+" : ""}${backtest.expectancy}R`}
          tone={positive ? "bullish" : "bearish"}
        />
        <RiskMetric label="Profit factor" value={String(backtest.profitFactor)} />
        <RiskMetric label="Avg R" value={`${backtest.averageR}R`} />
        <RiskMetric label="Max DD" value={`${backtest.maxDrawdown}R`} tone="bearish" />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {positive
          ? "Similar breakout signals on this chart carried positive expectancy — historical support for acting when the engine confirms."
          : "Similar breakout signals on this chart lost money historically — demand extra confirmation before acting."}
      </p>
    </div>
  );
}

function QuantAiPanel({
  symbol,
  timeframe,
  evaluation,
}: {
  symbol: string;
  timeframe: TokenTimeframe;
  evaluation: SignalEvaluation;
}) {
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
    },
    [evaluation, symbol, timeframe, thinkingMode],
  );

  return (
    <IqCard className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <CardEyebrow>Quant AI</CardEyebrow>
          <h2 className="mt-2 flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Bot className="h-5 w-5 text-info" />
            Analyst Panel
          </h2>
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Brain className="h-4 w-4" />
          Thinking
          <Switch checked={thinkingMode} onCheckedChange={setThinkingMode} />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <ContextPill label="Signal" value={`${evaluation.confidence}/100`} />
        <ContextPill label="Regime" value={evaluation.regime.replaceAll("-", " ")} />
        <ContextPill label="Source" value="fallback" />
      </div>

      <div className="max-h-[360px] min-h-[220px] overflow-y-auto rounded-lg border border-border bg-surface p-3">
        {chat.length === 0 ? (
          <div className="flex h-full min-h-[190px] items-center justify-center text-sm text-muted-foreground">
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
                {item.role === "assistant" ? <MarkdownText text={item.text} /> : <p>{item.text}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Button type="button" size="sm" onClick={() => runAnalysis()}>
          <Play className="h-4 w-4" />
          Run analysis
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => runAnalysis("What would invalidate this setup?")}
        >
          Invalidation
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => runAnalysis("Critique the risk/reward and position sizing.")}
        >
          Risk check
        </Button>
      </div>

      <form
        className="flex gap-2"
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
          className="min-h-10 flex-1 resize-none text-sm"
          rows={2}
        />
        <Button type="submit" size="icon" disabled={question.trim().length === 0} aria-label="Send">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </IqCard>
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
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "num mt-1 truncate text-sm font-semibold",
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
