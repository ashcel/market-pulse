import { Link } from "@tanstack/react-router";
import { Bitcoin, Boxes, Gauge, Layers3, Sparkle } from "lucide-react";
import { useMemo } from "react";

import { CardEyebrow, IqCard } from "./iq-card";
import { MiniChart } from "./mini-chart";
import { SkeletonCard } from "./skeletons";
import { useMarketContext, useOpportunityScan, useRsScan, useSentiment } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import type { SparkPoint } from "@/lib/types";

/**
 * The five global-condition tiles above the fold. Every figure names its own
 * source: market cap / dominance come from the worker's breadth ingest, 24h
 * volume is Binance USDT turnover (not global volume), and the alt tile is a
 * 24h RS breadth read — deliberately NOT the 90-day "Altcoin Season Index".
 * Any tile whose source has not been ingested renders "unavailable", never a
 * zero.
 */

function compactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${value.toFixed(0)}`;
}

function Delta({ value, unit = "%" }: { value: number | null; unit?: string }) {
  if (value === null || !Number.isFinite(value)) return null;
  return (
    <span className={cn("num text-xs font-semibold", value >= 0 ? "text-bullish" : "text-bearish")}>
      {value >= 0 ? "+" : ""}
      {value.toFixed(2)}
      {unit}
    </span>
  );
}

function Tile({
  icon,
  label,
  value,
  delta,
  footer,
  children,
  to,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  to?: string;
  title?: string;
}) {
  const card = (
    <IqCard interactive={!!to} className="flex h-full flex-col gap-2" title={title}>
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
          {icon}
        </span>
        <CardEyebrow>{label}</CardEyebrow>
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="num text-xl font-bold tracking-tight sm:text-2xl">{value}</span>
        {delta}
      </div>
      {children}
      {footer && <div className="mt-auto text-[11px] text-muted-foreground">{footer}</div>}
    </IqCard>
  );
  return to ? (
    <Link to={to} className="block h-full">
      {card}
    </Link>
  ) : (
    card
  );
}

export function GlobalMetricsRow() {
  const context = useMarketContext();
  const scan = useOpportunityScan();
  const rs = useRsScan();
  const sentiment = useSentiment();

  const mcapSpark = useMemo<SparkPoint[]>(
    () => (context.data?.series ?? []).map((p) => ({ t: p.t, v: p.mcapUsd })),
    [context.data],
  );
  const domSpark = useMemo<SparkPoint[]>(
    () => (context.data?.series ?? []).map((p) => ({ t: p.t, v: p.btcDominance })),
    [context.data],
  );

  const latest = context.data?.latest ?? null;
  const prior = context.data?.prior24h ?? null;
  const domDelta =
    latest && prior ? Number((latest.btcDominance - prior.btcDominance).toFixed(2)) : null;

  if (context.isLoading && scan.isLoading && rs.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} height={132} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Tile
        icon={<Boxes className="h-3.5 w-3.5" />}
        label="Market Cap"
        value={latest ? compactUsd(latest.totalMcapUsd) : "—"}
        delta={<Delta value={latest?.mcapChange24hPct ?? null} />}
        footer={latest ? `Global · ${latest.source}` : "Breadth ingest unavailable"}
      >
        {mcapSpark.length > 1 && <MiniChart data={mcapSpark} tone="bullish" height={28} />}
      </Tile>

      <Tile
        icon={<Layers3 className="h-3.5 w-3.5" />}
        label="24h Volume"
        title="Summed USDT turnover across every Binance USDT pair — exchange volume, not global crypto volume."
        value={scan.data ? compactUsd(scan.data.exchangeQuoteVolume24h) : "—"}
        footer={
          scan.data ? `Binance USDT · ${scan.data.pairsSeen} pairs` : "Exchange scan unavailable"
        }
        to="/discover"
      />

      <Tile
        icon={<Bitcoin className="h-3.5 w-3.5" />}
        label="BTC Dominance"
        value={latest ? `${latest.btcDominance.toFixed(2)}%` : "—"}
        delta={<Delta value={domDelta} unit="pp" />}
        footer={
          latest?.ethDominance != null
            ? `ETH ${latest.ethDominance.toFixed(2)}%`
            : "Breadth ingest unavailable"
        }
      >
        {domSpark.length > 1 && (
          <MiniChart
            data={domSpark}
            tone={(domDelta ?? 0) >= 0 ? "bullish" : "bearish"}
            height={28}
          />
        )}
      </Tile>

      <Tile
        icon={<Gauge className="h-3.5 w-3.5" />}
        label="Fear & Greed"
        title={
          sentiment.data?.source === "proxy"
            ? "The Fear & Greed API was unreachable — internal breadth/momentum estimate."
            : undefined
        }
        value={sentiment.data ? sentiment.data.fearGreed : "—"}
        footer={
          sentiment.data
            ? `${sentiment.data.label}${sentiment.data.source === "proxy" ? " · estimated" : ""}`
            : "Sentiment unavailable"
        }
        to="/news"
      >
        {sentiment.data && <FearGreedBar value={sentiment.data.fearGreed} />}
      </Tile>

      <Tile
        icon={<Sparkle className="h-3.5 w-3.5" />}
        label="Alt Strength"
        title="Share of Binance's liquid USDT tier outperforming BTC over the last 24h. Not the 90-day Altcoin Season Index."
        value={rs.data ? `${rs.data.altsBeatingBtcPct}` : "—"}
        delta={<span className="text-xs text-muted-foreground">/100</span>}
        footer={rs.data ? `${rs.data.pairsRanked} pairs beating BTC (24h)` : "RS scan unavailable"}
        to="/rotation"
      >
        {rs.data && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full",
                rs.data.altsBeatingBtcPct >= 60
                  ? "bg-bullish"
                  : rs.data.altsBeatingBtcPct >= 40
                    ? "bg-warning"
                    : "bg-bearish",
              )}
              style={{ width: `${rs.data.altsBeatingBtcPct}%` }}
            />
          </div>
        )}
      </Tile>
    </div>
  );
}

function FearGreedBar({ value }: { value: number }) {
  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-bearish via-warning to-bullish">
        <div
          className="absolute -top-1 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-background bg-foreground"
          style={{ left: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Fear</span>
        <span>Greed</span>
      </div>
    </div>
  );
}
