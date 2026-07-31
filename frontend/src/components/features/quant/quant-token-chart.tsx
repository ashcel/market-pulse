import { useQuery } from "@tanstack/react-query";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import { apiV1Json } from "../miniapp/api";
import type { QuantTokenDetail } from "./types";

/**
 * Daily candles from the quant dashboard with its forecast drawn on top:
 * translucent projected candles, the ATR*sqrt(i) confidence cone as an area
 * band, and a dashed projected-close path. Colours match the notifier
 * dashboard's own chart so the same forecast reads identically in both places.
 *
 * The projection is a model output, not a prediction of record — the footer
 * states its TP/SL hit probabilities rather than letting the drawing imply
 * certainty.
 */

const FORECAST_UP = "rgba(0,180,255,0.35)";
const FORECAST_DOWN = "rgba(255,120,120,0.35)";
const CONE_TOP = "rgba(0,180,255,0.08)";
const CONE_BOTTOM = "rgba(0,180,255,0.02)";

export function QuantTokenChart({ symbol, onBack }: { symbol: string; onBack?: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const query = useQuery({
    queryKey: ["quant-token", symbol],
    queryFn: () => apiV1Json<QuantTokenDetail>(`/api/v1/quant/token?symbol=${symbol}`),
    staleTime: 60_000,
  });

  const detail = query.data;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !detail || !detail.candles || detail.candles.length < 2) return;

    const chart = createChart(host, {
      width: Math.max(host.clientWidth, 1),
      height: Math.max(host.clientHeight, 1),
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.64)",
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;

    const real = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#f43f5e",
      wickUpColor: "#22c55e",
      wickDownColor: "#f43f5e",
      borderVisible: false,
    });
    real.setData(detail.candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));

    const forecast = detail.forecast;
    if (forecast?.candles?.length) {
      const cone = chart.addSeries(AreaSeries, {
        lineColor: "rgba(0,180,255,0)",
        topColor: CONE_TOP,
        bottomColor: CONE_BOTTOM,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      cone.setData(
        (forecast.cone ?? []).map((c) => ({ time: c.time as UTCTimestamp, value: c.upper })),
      );

      const projected = chart.addSeries(CandlestickSeries, {
        upColor: FORECAST_UP,
        downColor: FORECAST_DOWN,
        wickUpColor: FORECAST_UP,
        wickDownColor: FORECAST_DOWN,
        borderVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      projected.setData(
        forecast.candles.map((c) => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );

      const path = chart.addSeries(LineSeries, {
        color: "rgba(0,180,255,0.6)",
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      path.setData(forecast.candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
    }

    chart.timeScale().fitContent();

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
    };
  }, [detail]);

  const meta = detail?.forecast?.metadata;
  const pct = (v: number | undefined) => Math.round((v ?? 0) * 100);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight">{symbol}</span>
          {detail?.last != null && (
            <span className="num text-xs text-muted-foreground">{detail.last}</span>
          )}
        </div>
        {onBack && (
          <button
            onClick={onBack}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground"
          >
            Kembali
          </button>
        )}
      </div>

      {query.isLoading && <div className="h-56 animate-pulse rounded-lg bg-surface" />}
      {query.isError && (
        <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
          Chart gagal dimuat: {(query.error as Error).message}
        </div>
      )}
      {detail?.error && (
        <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
          {detail.error}
        </div>
      )}

      {detail && !detail.error && (
        <>
          <div ref={hostRef} className="h-56 w-full" />
          <div className="text-[11px] text-muted-foreground">
            {meta
              ? `🎯 TP ~${pct(meta.tpHitProbability)}% · SL ~${pct(meta.slHitProbability)}% · ~${
                  meta.barsToTp == null ? "—" : Math.round(meta.barsToTp)
                } bar ke TP`
              : "Forecast tidak tersedia untuk token ini."}
          </div>
          {detail.fundingRate != null && (
            <div className="text-[11px] text-muted-foreground">
              funding {(detail.fundingRate * 100).toFixed(4)}%
            </div>
          )}
        </>
      )}
    </div>
  );
}
