import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { CardEyebrow } from "@/components/features/iq-card";
import type { Candle } from "@/lib/engine/types";
import {
  buildForecast,
  ENSEMBLE_PATHS,
  MIN_REAL_CANDLES,
  type ForecastResult,
} from "@/lib/forecast";
import { cn } from "@/lib/utils";

/**
 * The projection cone, rendered from the in-app forecast engine
 * (`@/lib/forecast`) — no `/quant/token` proxy involved (Sprint 5 task 5).
 *
 * Drawn as an inline SVG rather than a `lightweight-charts` instance: this
 * sits inside the Ticket, which the user is actively typing into, and a second
 * chart instance re-created on every keystroke is both janky and expensive on
 * a 660 MB box. The shape is what carries the meaning here, not price
 * readout — the numbers underneath do that.
 *
 * The wording is deliberately hedged. This is a seeded illustration of the
 * plan, not a forecast of record: showing a cone next to a hit-probability
 * invites reading it as a measurement, and it is not one (R3).
 */

interface ForecastConeProps {
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  /** Timeframe the projection is drawn on; also what candles are fetched. */
  timeframe?: string;
  market?: "spot" | "perp";
  /** Distinguishes two plans on the same symbol+day in the seed. */
  kind?: string;
}

function useCandles(symbol: string, timeframe: string, market: string, enabled: boolean) {
  return useQuery({
    queryKey: ["forecast-candles", symbol, timeframe, market],
    queryFn: async (): Promise<Candle[]> => {
      const params = new URLSearchParams({ symbol, timeframe, limit: "120", market });
      const res = await fetch(`/api/klines?${params}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`klines fetch failed: ${res.status}`);
      return (await res.json()) as Candle[];
    },
    enabled: enabled && Boolean(symbol),
    staleTime: 60_000,
  });
}

function pct(value: number | undefined | null): string {
  return value === undefined || value === null ? "—" : `${Math.round(value * 100)}%`;
}

/** Maps prices into a 0..1 band, inverted for SVG's top-left origin. */
function scaler(min: number, max: number): (price: number) => number {
  const span = max - min || 1;
  return (price) => 1 - (price - min) / span;
}

function ConeSvg({
  forecast,
  real,
  entry,
  stop,
  target,
  bullish,
}: {
  forecast: ForecastResult;
  real: Candle[];
  entry: number;
  stop: number;
  target: number;
  bullish: boolean;
}) {
  const tail = real.slice(-24);
  const prices = [
    ...tail.flatMap((c) => [c.high, c.low]),
    ...forecast.cone.flatMap((c) => [c.upper, c.lower]),
    entry,
    stop,
    target,
  ].filter((n) => Number.isFinite(n));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const y = scaler(min, max);

  const total = tail.length + forecast.candles.length;
  const x = (i: number) => (total <= 1 ? 0 : i / (total - 1));

  const realPath = tail
    .map((c, i) => `${i === 0 ? "M" : "L"} ${x(i) * 100} ${y(c.close) * 100}`)
    .join(" ");
  const projPath = forecast.candles
    .map((c, i) => `${i === 0 ? "M" : "L"} ${x(tail.length + i) * 100} ${y(c.close) * 100}`)
    .join(" ");
  const band = [
    ...forecast.cone.map(
      (c, i) => `${i === 0 ? "M" : "L"} ${x(tail.length + i) * 100} ${y(c.upper) * 100}`,
    ),
    ...[...forecast.cone]
      .reverse()
      .map((c, i) => `L ${x(total - 1 - i) * 100} ${y(c.lower) * 100}`),
    "Z",
  ].join(" ");

  const accent = bullish ? "var(--color-bullish, #22c55e)" : "var(--color-bearish, #f43f5e)";

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="h-32 w-full"
      role="img"
      aria-label="Proyeksi harga terhadap rencana"
    >
      {[
        { price: target, color: "var(--color-bullish, #22c55e)" },
        { price: entry, color: "currentColor" },
        { price: stop, color: "var(--color-bearish, #f43f5e)" },
      ].map(({ price, color }) => (
        <line
          key={price}
          x1={0}
          x2={100}
          y1={y(price) * 100}
          y2={y(price) * 100}
          stroke={color}
          strokeWidth={0.4}
          strokeDasharray="2 2"
          opacity={0.45}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path d={band} fill={accent} opacity={0.12} />
      <path
        d={realPath}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={projPath}
        fill="none"
        stroke={accent}
        strokeWidth={1}
        strokeDasharray="3 2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ForecastCone({
  symbol,
  side,
  entry,
  stop,
  target,
  timeframe = "1H",
  market = "perp",
  kind = "ticket",
}: ForecastConeProps) {
  const planReady = [entry, stop, target].every((n) => Number.isFinite(n) && n > 0);
  const candles = useCandles(symbol, timeframe, market, planReady);

  const forecast = useMemo(() => {
    if (!planReady || !candles.data?.length) return null;
    return buildForecast({
      symbol,
      kind,
      direction: side === "LONG" ? "long" : "short",
      entry,
      stop,
      target,
      candles: candles.data,
    });
  }, [planReady, candles.data, symbol, kind, side, entry, stop, target]);

  if (!planReady) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <CardEyebrow className="flex items-center justify-between">
        <span>Proyeksi</span>
        <span className="text-[10px] font-normal normal-case text-muted-foreground">
          ilustrasi rencana, bukan ramalan
        </span>
      </CardEyebrow>

      {candles.isLoading && <div className="mt-3 h-32 animate-pulse rounded bg-card" />}

      {!candles.isLoading && !forecast && (
        <p className="mt-2 text-xs text-muted-foreground">
          {(candles.data?.length ?? 0) < MIN_REAL_CANDLES
            ? "Data candle belum cukup untuk menggambar proyeksi."
            : "Rencana belum bisa diproyeksikan — periksa posisi stop dan target terhadap entry."}
        </p>
      )}

      {forecast && candles.data && (
        <>
          <div className="mt-2 text-muted-foreground">
            <ConeSvg
              forecast={forecast}
              real={candles.data}
              entry={entry}
              stop={stop}
              target={target}
              bullish={side === "LONG"}
            />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
            <div>
              <div className="text-muted-foreground">Sentuh target</div>
              <div className={cn("num font-semibold", "text-bullish")}>
                {pct(forecast.metadata.tpHitProbability)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Kena stop</div>
              <div className="num font-semibold text-bearish">
                {pct(forecast.metadata.slHitProbability)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Bar ke target</div>
              <div className="num font-semibold">
                {forecast.metadata.barsToTp === null ? "—" : Math.round(forecast.metadata.barsToTp)}
              </div>
            </div>
          </div>
          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            {forecast.metadata.candleCount} bar ke depan dari jalur acak ber-seed yang dibentuk
            rencanamu sendiri. Angka di atas dari {ENSEMBLE_PATHS} jalur simulasi, bukan dari hasil
            nyata — track record ada di Lab.
          </p>
        </>
      )}
    </div>
  );
}
