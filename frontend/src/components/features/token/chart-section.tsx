import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
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
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

import { ChartEventPopup, ChartEventStrip } from "@/components/features/chart-event-strip";
import { ZonesPrimitive, type PriceZone } from "@/components/features/chart-zones";
import { IqCard } from "@/components/features/iq-card";
import { TradeActionOverlay } from "@/components/features/trade-action-overlay";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TokenSignalData } from "@/hooks/useTokenSignal";
import { computeEmaSeries } from "@/lib/engine/analysis";
import { fetchBinanceKlines, type MarketType } from "@/lib/engine/binance";
import type { Candle } from "@/lib/engine/types";
import { TONE_HEX, kindLabel, snapToCandle, type ChartEvent } from "@/lib/engine/event-markers";
import { detectFvgs, selectFvgs } from "@/lib/engine/fvg";
import { detectOrderBlocks, selectOrderBlocks } from "@/lib/engine/orderblocks";
import { buildPoiMap, TERMINAL_POI_STATES, type UnifiedPoi } from "@/lib/engine/poi-map";
import type { RiskRewardPlan } from "@/lib/engine/quant";
import type { SessionLevel } from "@/lib/engine/sessions";
import type { MarketStructure } from "@/lib/engine/structure";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import { computeBaseZones, SD_ZONE_TIMEFRAMES, type BaseZone } from "@/lib/engine/zones";
import { usePreferencesStore, type ChartIndicatorKey } from "@/stores/preferences";
import { cn } from "@/lib/utils";

export const EMA_FAST = { length: 13, color: "#38bdf8" };
export const EMA_SLOW = { length: 21, color: "#a78bfa" };

// Session H/L lines are only meaningful on intraday charts; on daily/weekly
// they'd just clutter far below/above the visible action.
export const SESSION_LINE_TIMEFRAMES: readonly TokenTimeframe[] = ["15M", "30M", "1H", "4H"];
export const SESSION_LINE_COLORS: Record<string, string> = {
  asia: "#f472b6", // pink
  eu: "#2dd4bf", // teal
  us: "#fb923c", // orange
};
export type IndicatorKey = ChartIndicatorKey;
// Bars fetched per page when the user drags past the oldest loaded candle.
export const HISTORY_PAGE = 500;

// Most recent swing legs drawn as labeled chart markers; older legs sit
// outside the story the current structure tells and would only add clutter.
export const MAX_STRUCTURE_MARKERS = 8;

export class ChartErrorBoundary extends React.Component<
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

export function TokenChart({
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
export function computeSetupZones(
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
export function baseZonesToPriceZones(zones: BaseZone[]): PriceZone[] {
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
export function poiOverlaysToPriceZones(pois: UnifiedPoi[]): PriceZone[] {
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

export function toLineData(points: Array<{ time: number; value: number }>): LineData<Time>[] {
  return (points || [])
    .filter((point) => point && Number.isFinite(point.time) && Number.isFinite(point.value))
    .map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
}

export function lineSwatch(color: string, dashed = false) {
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

export const LEGEND_ENTRIES: Array<{
  key: IndicatorKey;
  label: string;
  hint: string;
  swatch: ReactNode;
}> = [
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
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TONE_HEX.bearish }} />
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TONE_HEX.neutral }} />
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TONE_HEX.bullish }} />
      </span>
    ),
  },
];

export function ChartLegend({
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
export function pricePrecision(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 100 || abs === 0) return 2;
  if (abs >= 1) return 3;
  if (abs >= 0.01) return 5;
  return Math.min(10, -Math.floor(Math.log10(abs)) + 3);
}

export function computeChange24h(candles: TokenSignalData["candles"]): number {
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
