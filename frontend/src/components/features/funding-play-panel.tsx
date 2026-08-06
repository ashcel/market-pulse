import { useMemo, useEffect, useState } from "react";
import { Scale, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CardEyebrow } from "@/components/features/iq-card";
import { StatusBadge } from "@/components/features/status-badge";
import { FundingCautionBanner, verdictDisplay } from "@/components/features/funding-plays-card";
import { useFundingScan } from "@/hooks/queries";
import { useLiveFunding } from "@/hooks/useLiveFunding";
import { useFundingBacktest } from "@/hooks/useFundingBacktest";
import {
  adviseFundingPlay,
  type FundingPlayAdvice,
  type FundingRow,
} from "@/lib/engine/funding-play";
import { cn } from "@/lib/utils";
import type { MarketType } from "@/lib/engine/binance";

interface FundingPlayPanelProps {
  symbol: string;
  market: MarketType;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}:${mins.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatCurrency(value: number): string {
  if (value === 0) return "$0";
  const sign = value < 0 ? "-" : "+";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

interface FundingBacktestDisplayProps {
  backtest: {
    source: "live" | "demo";
    symbol: string;
    pair: string;
    lookbackDays: number;
    extremeCount: number;
    updatedAt: string;
    report: {
      pair: string;
      ticker: string;
      n: number;
      winRateHarvest: number;
      winRateReversal: number;
      totalPnl: number;
      avgPnl: number;
      medianPnl: number;
      expectancy: number;
      maxDrawdown: number;
      buckets: Array<{
        label: string;
        minAbsRate: number;
        maxAbsRate: number;
        n: number;
        winRate: number;
        avgPnl: number;
      }>;
      equityCurve: Array<{
        settlementMs: number;
        equity: number;
      }>;
      instances: Array<{
        pair: string;
        settlementMs: number;
        settledRate: number;
        side: string;
        harvest: {
          pnlUsd: number;
          fundingUsd: number;
          priceMoveUsd: number;
          feesUsd: number;
          stopped: boolean;
          maePct: number;
          mfePct: number;
        };
        reversal: {
          pnlUsd: number;
          fundingUsd: number;
          priceMoveUsd: number;
          feesUsd: number;
          stopped: boolean;
          maePct: number;
          mfePct: number;
        };
      }>;
      config: object;
    };
  };
}

function EquityCurveSparkline({
  curve,
}: {
  curve: Array<{ settlementMs: number; equity: number }>;
}) {
  if (curve.length === 0) return null;

  const width = 100;
  const height = 24;
  const minEquity = Math.min(...curve.map((p) => p.equity));
  const maxEquity = Math.max(...curve.map((p) => p.equity));
  const range = maxEquity - minEquity || 1;

  const points = curve
    .map((p, i) => {
      const x = (i / (curve.length - 1 || 1)) * width;
      const y = height - ((p.equity - minEquity) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width="100%" height={height} className="text-muted-foreground">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function FundingBacktestDisplay({ backtest }: FundingBacktestDisplayProps) {
  const { t } = useTranslation();
  const { report } = backtest;

  if (report.n === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("components.batchG.fundingPlayPanel.noExtremeSettlements", {
          days: backtest.lookbackDays,
        })}
      </p>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-muted-foreground">
          {t("components.batchG.fundingPlayPanel.instancesOverDays", {
            count: report.n,
            days: backtest.lookbackDays,
          })}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {t("components.batchG.fundingPlayPanel.flaggedCount", { count: backtest.extremeCount })}
        </span>
        {backtest.source === "demo" && (
          <>
            <span className="text-muted-foreground">·</span>
            <StatusBadge tone="warning">
              {t("components.batchG.fundingPlayPanel.noLiveHistory")}
            </StatusBadge>
          </>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-1 rounded border border-border/50 bg-muted/20 p-2">
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.harvestWr")}
          </div>
          <div className="text-xs font-semibold text-foreground">
            {(report.winRateHarvest * 100).toFixed(0)}%
          </div>
        </div>
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.reversalWr")}
          </div>
          <div className="text-xs font-semibold text-foreground">
            {(report.winRateReversal * 100).toFixed(0)}%
          </div>
        </div>
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.total")}
          </div>
          <div
            className={cn(
              "text-xs font-semibold",
              report.totalPnl >= 0 ? "text-bullish" : "text-bearish",
            )}
          >
            {formatCurrency(report.totalPnl)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.expectancy")}
          </div>
          <div
            className={cn(
              "text-xs font-semibold",
              report.expectancy >= 0 ? "text-bullish" : "text-bearish",
            )}
          >
            {formatCurrency(report.expectancy)}
          </div>
        </div>
      </div>

      {/* More stats */}
      <div className="grid grid-cols-3 gap-1 rounded border border-border/50 bg-muted/20 p-2">
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.avgPnl")}
          </div>
          <div
            className={cn(
              "text-xs font-semibold",
              report.avgPnl >= 0 ? "text-bullish" : "text-bearish",
            )}
          >
            {formatCurrency(report.avgPnl)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.medianPnl")}
          </div>
          <div
            className={cn(
              "text-xs font-semibold",
              report.medianPnl >= 0 ? "text-bullish" : "text-bearish",
            )}
          >
            {formatCurrency(report.medianPnl)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.maxDrawdown")}
          </div>
          <div
            className={cn(
              "text-xs font-semibold",
              report.maxDrawdown >= 0 ? "text-bullish" : "text-bearish",
            )}
          >
            {formatCurrency(report.maxDrawdown)}
          </div>
        </div>
      </div>

      {/* Buckets table */}
      {report.buckets.length > 0 && (
        <div className="border border-border/50 rounded overflow-hidden">
          <div className="bg-muted/20 px-2 py-1 grid grid-cols-4 gap-1 text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            <div>{t("components.batchG.fundingPlayPanel.range")}</div>
            <div className="text-center">{t("components.batchG.fundingPlayPanel.n")}</div>
            <div className="text-center">{t("components.batchG.fundingPlayPanel.wr")}</div>
            <div className="text-right">{t("components.batchG.fundingPlayPanel.avgPnl")}</div>
          </div>
          {report.buckets.map((bucket, i) => {
            const isMainBand = bucket.minAbsRate >= 0.02;
            return (
              <div
                key={i}
                className={cn(
                  "px-2 py-1 grid grid-cols-4 gap-1 border-t border-border/30 text-[10px]",
                  isMainBand && "font-medium bg-surface/50",
                )}
              >
                <div className="text-foreground truncate">
                  {(bucket.minAbsRate * 100).toFixed(1)}%–{(bucket.maxAbsRate * 100).toFixed(1)}%
                </div>
                <div className="text-center text-muted-foreground">{bucket.n}</div>
                <div className="text-center text-muted-foreground">
                  {(bucket.winRate * 100).toFixed(0)}%
                </div>
                <div
                  className={cn("text-right", bucket.avgPnl >= 0 ? "text-bullish" : "text-bearish")}
                >
                  {formatCurrency(bucket.avgPnl)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Equity curve */}
      {report.equityCurve.length > 0 && (
        <div className="border border-border/50 rounded p-2 bg-muted/20">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            {t("components.batchG.fundingPlayPanel.equityCurve")}
          </div>
          <EquityCurveSparkline curve={report.equityCurve} />
        </div>
      )}

      {/* Footer caveat */}
      <p className="text-[9px] leading-relaxed text-muted-foreground italic">
        {t("components.batchG.fundingPlayPanel.backtestCaveat")}
      </p>
    </div>
  );
}

export function FundingPlayPanel({ symbol, market }: FundingPlayPanelProps) {
  const { t } = useTranslation();
  const { data: scan } = useFundingScan();
  const live = useLiveFunding(symbol, market);
  const [nowMs, setNowMs] = useState(Date.now());
  const [backtestExpanded, setBacktestExpanded] = useState(false);
  const { data: backtest, isLoading: backtestLoading } = useFundingBacktest(
    symbol,
    backtestExpanded,
  );

  // Tick countdown every second
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Find the scan play for this symbol
  const scanPlay = useMemo(
    () => scan?.plays.find((p) => p.ticker === symbol.toUpperCase()),
    [scan, symbol],
  );

  // Compute live advice
  const advice = useMemo(() => {
    if (!live) return scanPlay;

    const row: FundingRow = {
      ticker: symbol.toUpperCase(),
      pair: scanPlay?.pair ?? symbol.toUpperCase() + "USDT",
      fundingRate: live.fundingRate,
      nextFundingMs: live.nextFundingMs,
      markPrice: live.markPrice,
      indexPrice: live.markPrice,
      intervalHours: scanPlay?.intervalHours ?? 8,
    };
    const computed = adviseFundingPlay(row, nowMs);
    return computed || scanPlay;
  }, [live, scanPlay, symbol, nowMs]);

  if (market !== "perp") return null;

  // If no advice at all, show compact fallback
  if (!advice) {
    if (live) {
      const minutesToFunding = Math.max(0, (live.nextFundingMs - nowMs) / 60000);
      const countdown = formatCountdown(minutesToFunding * 60000);
      return (
        <div className="rounded-lg border border-border bg-surface p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <CardEyebrow>{t("components.batchG.fundingPlayPanel.fundingWatch")}</CardEyebrow>
            </div>
          </div>
          <div className="mt-2">
            <FundingCautionBanner />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <div className="rounded-md border border-border bg-card px-2 py-1.5">
              <div className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                <Scale className="h-3 w-3" />
                {t("components.batchG.fundingPlayPanel.rate")}
              </div>
              <div className="num mt-0.5 text-sm font-semibold text-foreground">
                {(live.fundingRate * 100).toFixed(4)}%
              </div>
            </div>
            <div className="rounded-md border border-border bg-card px-2 py-1.5">
              <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("components.batchG.fundingPlayPanel.settlement")}
              </div>
              <div className="num mt-0.5 text-sm font-semibold text-foreground">{countdown}</div>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  const minutesToFunding = Math.max(0, (live?.nextFundingMs ?? 0 - nowMs) / 60000);
  const countdown = formatCountdown(minutesToFunding * 60000);
  const { label: verdictLabel, tone: verdictTone } = verdictDisplay(advice.verdict, t);

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <CardEyebrow className="flex-shrink-0">
            {t("components.batchG.fundingPlayPanel.fundingWatch")}
          </CardEyebrow>
          <span className="text-sm font-medium text-foreground truncate">
            {t("components.batchG.fundingPlayPanel.sideReceives", { side: advice.side })}
          </span>
        </div>
        <StatusBadge tone={verdictTone} className="shrink-0">
          {verdictLabel}
        </StatusBadge>
      </div>

      <div className="mb-3">
        <FundingCautionBanner />
      </div>

      {/* Rate, interval, countdown */}
      <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
        <div className="rounded px-2 py-1 bg-card border border-border">
          <span className="text-muted-foreground">
            {t("components.batchG.fundingPlayPanel.rateColon")}
          </span>
          <span className="font-semibold text-foreground">
            {(advice.fundingRate * 100).toFixed(2)}%
          </span>
        </div>
        {advice.intervalHours !== 8 && (
          <div className="rounded px-2 py-1 bg-card border border-border border-warning/50 bg-warning-soft text-warning font-medium">
            {t("components.batchG.fundingPlayPanel.intervalHours", {
              hours: advice.intervalHours,
            })}
          </div>
        )}
        <div className="rounded px-2 py-1 bg-card border border-border">
          <span className="text-muted-foreground">
            {t("components.batchG.fundingPlayPanel.settlementColon")}
          </span>
          <span className="font-semibold text-foreground">{countdown}</span>
        </div>
      </div>

      {/* Numbers row */}
      <div className="mb-3 grid grid-cols-5 gap-1.5">
        <div className="rounded px-1.5 py-1 bg-card border border-border text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.gross")}
          </div>
          <div className="text-xs font-semibold text-foreground">
            {advice.grossCapturePct.toFixed(2)}%
          </div>
        </div>
        <div className="rounded px-1.5 py-1 bg-card border border-border text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.fees")}
          </div>
          <div className="text-xs font-semibold text-bearish">{advice.feesPct.toFixed(2)}%</div>
        </div>
        <div className="rounded px-1.5 py-1 bg-card border border-border text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.net")}
          </div>
          <div
            className={cn(
              "text-xs font-semibold",
              advice.netEdgePct > 0 ? "text-bullish" : "text-bearish",
            )}
          >
            {advice.netEdgePct.toFixed(2)}%
          </div>
        </div>
        <div className="rounded px-1.5 py-1 bg-card border border-border text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.breakeven")}
          </div>
          <div className="text-xs font-semibold text-foreground">
            {advice.breakevenMovePct.toFixed(2)}%
          </div>
        </div>
        <div className="rounded px-1.5 py-1 bg-card border border-border text-center">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("components.batchG.fundingPlayPanel.notional")}
          </div>
          <div className="text-xs font-semibold text-foreground">
            ${Math.round(advice.suggestedNotionalUsd)}
          </div>
        </div>
      </div>

      {/* Expected capture */}
      <div className="mb-3 rounded px-2 py-1.5 bg-card border border-border">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
          {t("components.batchG.fundingPlayPanel.expectedCapture")}
        </div>
        <div className="text-sm font-semibold text-foreground">
          ${advice.expectedCaptureUsd.toFixed(2)}
        </div>
      </div>

      {/* Note */}
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{advice.note}</p>

      {/* What flips it */}
      <div className="mb-3 rounded px-2 py-1.5 bg-info/5 border border-info/20">
        <div className="text-[9px] uppercase tracking-wider text-info font-semibold mb-1">
          {t("components.batchG.fundingPlayPanel.conditionToFlip")}
        </div>
        <p className="text-[11px] font-medium text-foreground">{advice.whatFlipsIt}</p>
      </div>

      {/* Hazards */}
      {advice.hazards.length > 0 && (
        <div className="mb-3 rounded px-2 py-1.5 bg-warning/5 border border-warning/20">
          <div className="text-[9px] uppercase tracking-wider text-warning font-semibold mb-1">
            {t("components.batchG.fundingPlayPanel.hazards")}
          </div>
          <ul className="space-y-0.5">
            {advice.hazards.map((h, i) => (
              <li key={i} className="text-[11px] text-foreground flex gap-1.5">
                <span className="text-warning shrink-0">•</span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Reversal note */}
      {advice.reversalNote && (
        <div className="rounded px-2 py-1.5 bg-muted/20 border border-muted/40">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            {t("components.batchG.fundingPlayPanel.reversalLeg")}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">{advice.reversalNote}</p>
        </div>
      )}

      {/* Backtest section */}
      <div className="mt-3 border-t border-border/50 pt-3">
        <button
          onClick={() => setBacktestExpanded(!backtestExpanded)}
          className="flex items-center justify-between w-full px-2 py-2 rounded hover:bg-surface/50 transition-colors"
        >
          <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            {backtestExpanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {t("components.batchG.fundingPlayPanel.backtestButton")}
          </span>
        </button>

        {backtestExpanded && (
          <div className="mt-2 pt-2 border-t border-border/50">
            {backtestLoading ? (
              <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("components.batchG.fundingPlayPanel.replayingSettlements")}
              </div>
            ) : backtest ? (
              <FundingBacktestDisplay backtest={backtest} />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
