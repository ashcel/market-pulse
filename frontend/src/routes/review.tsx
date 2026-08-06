import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  RefreshCw,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trophy,
  Skull,
  Clock,
  AlarmClock,
  Target,
  AlertTriangle,
  Zap,
} from "lucide-react";

import { AssetIcon } from "@/components/features/asset-icon";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { PageHeader } from "@/components/features/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useExecutions, type ExecutionRecord } from "@/hooks/useExecutions";
import { useForwardReturnEvidence, type HorizonEvidence } from "@/hooks/useForwardReturnEvidence";
import {
  useBinanceKeyStatus,
  useGenerateTradeReview,
  useReviewAnalytics,
  useReviewTrades,
  useSyncBinance,
  useTradeReview,
} from "@/hooks/useReview";
import { buildCandidates } from "@/lib/ai/chain";
import type { ReviewTrade, TradeReview } from "@/lib/review/types";
import { formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { requireSession } from "@/lib/auth/guard";

export const Route = createFileRoute("/review")({
  beforeLoad: () => requireSession("/review"),
  head: () => ({
    meta: [
      { title: "Trade Review — Market Pulse" },
      {
        name: "description",
        content: "Sync your Binance trade history and generate AI-powered per-trade reviews.",
      },
      { property: "og:title", content: "Trade Review — Market Pulse" },
      {
        property: "og:description",
        content: "RR, best/worst trades, time-of-day edge, session breakdown, and AI reviews.",
      },
    ],
  }),
  component: ReviewPage,
});

type SideFilter = "all" | "LONG" | "SHORT";
const SIDE_FILTERS: { labelKey: string; value: SideFilter }[] = [
  { labelKey: "filterAll", value: "all" },
  { labelKey: "filterLong", value: "LONG" },
  { labelKey: "filterShort", value: "SHORT" },
];

function formatPnl(pnl: number | null | undefined): string {
  if (pnl === null || pnl === undefined) return "—";
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}${formatMoney(pnl)}`;
}

function pnlTone(pnl: number | null | undefined): string {
  if (pnl === null || pnl === undefined) return "text-muted-foreground";
  return pnl >= 0 ? "text-bullish" : "text-bearish";
}

function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function baseSymbol(symbol: string): string {
  return symbol.endsWith("USDT") ? symbol.slice(0, -"USDT".length) : symbol;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const GRADE_TONE: Record<string, string> = {
  "A+": "border-bullish/30 bg-bullish-soft text-bullish",
  A: "border-bullish/30 bg-bullish-soft text-bullish",
  B: "border-info/30 bg-info-soft text-info",
  C: "border-warning/30 bg-warning-soft text-warning",
  D: "border-bearish/30 bg-bearish-soft text-bearish",
  F: "border-bearish/30 bg-bearish-soft text-bearish",
};

const SECTION_ORDER = [
  "what_happened",
  "what_went_well",
  "risks_weaknesses",
  "the_moment",
] as const;

// ── Page ──────────────────────────────────────────────────────────────────────

function ReviewPage() {
  const { t } = useTranslation();
  const [sideFilter, setSideFilter] = useState<SideFilter>("all");
  const { trades, authenticated, isLoading } = useReviewTrades();
  const aiSettings = useAiSettingsStore();
  // Usable if ANY endpoint in the fallback chain resolves — not only the
  // provider currently selected in Settings.
  const aiConfigured = buildCandidates(aiSettings).length > 0;

  const filteredTrades =
    sideFilter === "all" ? trades : trades.filter((t) => t.side === sideFilter);

  return (
    <div className="space-y-5 pb-20 lg:pb-6">
      <PageHeader
        eyebrow={t("routes.review.eyebrow")}
        title={t("routes.review.title")}
        subtitle={t("routes.review.subtitle")}
      />

      <SyncCard authenticated={authenticated} />

      <LiveExecutionsSection />

      <TrackRecordSection authenticated={authenticated} />

      {!authenticated ? (
        <NotSignedInCard />
      ) : (
        <>
          <AnalyticsHero />
          <StyleBucketTable />

          <div className="flex items-center gap-1.5">
            {SIDE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setSideFilter(f.value)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                  sideFilter === f.value
                    ? "border-info/30 bg-info-soft text-info"
                    : "border-border bg-surface text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`routes.review.${f.labelKey}`)}
              </button>
            ))}
          </div>

          {isLoading ? (
            <IqCard className="text-center text-sm text-muted-foreground py-6">
              {t("routes.review.loadingTrades")}
            </IqCard>
          ) : filteredTrades.length === 0 ? (
            <IqCard className="text-center text-sm text-muted-foreground py-6">
              {trades.length === 0
                ? t("routes.review.noTradesSynced")
                : t("routes.review.noSideTrades", { side: sideFilter.toLowerCase() })}
            </IqCard>
          ) : (
            <div className="space-y-2.5">
              {filteredTrades.map((trade) => (
                <TradeReviewRow
                  key={trade.id}
                  trade={trade}
                  allTrades={trades}
                  aiConfigured={aiConfigured}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NotSignedInCard() {
  const { t } = useTranslation();
  return (
    <IqCard className="space-y-2 text-center text-sm text-muted-foreground">
      <p>{t("routes.review.signInPrompt1")}</p>
      <p>
        <Link to="/login" className="font-medium text-info underline-offset-2 hover:underline">
          {t("common.signIn")}
        </Link>{" "}
        {t("routes.review.signInPrompt2")}
      </p>
    </IqCard>
  );
}

// ── Sync / connection card ──────────────────────────────────────────────────

function SyncCard({ authenticated }: { authenticated: boolean }) {
  const { t } = useTranslation();
  const { connected, lastSyncedAt, isLoading } = useBinanceKeyStatus();
  const sync = useSyncBinance();

  if (!authenticated) return null;

  return (
    <IqCard className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <CardEyebrow>{t("routes.review.binanceSync")}</CardEyebrow>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
              connected ? "bg-bullish-soft text-bullish" : "bg-muted text-muted-foreground",
            )}
          >
            {isLoading
              ? t("routes.review.checking")
              : connected
                ? t("routes.review.connected")
                : t("routes.review.notConnected")}
          </span>
          {connected && (
            <span className="text-xs text-muted-foreground">
              {lastSyncedAt
                ? t("routes.review.lastSynced", { date: new Date(lastSyncedAt).toLocaleString() })
                : t("routes.review.neverSynced")}
            </span>
          )}
        </div>
        {sync.isError && (
          <p className="mt-1 text-xs text-destructive">{(sync.error as Error).message}</p>
        )}
      </div>

      {connected ? (
        <Button
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", sync.isPending && "animate-spin")} />
          {sync.isPending ? t("routes.review.syncing") : t("routes.review.syncNow")}
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="text-xs" asChild>
          <Link to="/settings">{t("routes.review.connectBinanceInSettings")}</Link>
        </Button>
      )}
    </IqCard>
  );
}

// ── Live executions (Binance testnet) ───────────────────────────────────────

const EXECUTION_STATUS_TONE: Record<string, "bullish" | "bearish" | "neutral"> = {
  PROTECTED: "bullish",
  FLATTENED: "bearish",
  UNPROTECTED_CRITICAL: "bearish",
  ENTRY_REJECTED: "bearish",
  TP_FAILED: "bearish",
  RECONCILIATION_REQUIRED: "bearish",
  PENDING_ENTRY: "neutral",
  ENTRY_SUBMITTED: "neutral",
  ENTRY_CONFIRMED: "neutral",
  PROTECTION_SUBMITTED: "neutral",
  FLATTEN_SUBMITTED: "neutral",
};

function executionStatusTone(status: string): "bullish" | "bearish" | "neutral" {
  return EXECUTION_STATUS_TONE[status] ?? "neutral";
}

function executionStatusClass(status: string): string {
  const tone = executionStatusTone(status);
  if (tone === "bullish") return "border-bullish/30 bg-bullish-soft text-bullish";
  if (tone === "bearish") return "border-bearish/30 bg-bearish-soft text-bearish";
  return "border-border bg-muted text-muted-foreground";
}

function executionStatusLabel(status: string): string {
  return status
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

/** Live executions section — user-confirmed Binance (testnet) order placements. */
function LiveExecutionsSection() {
  const { t } = useTranslation();
  const { executions, authenticated, isLoading } = useExecutions();

  if (!authenticated) return null;
  if (!isLoading && executions.length === 0) return null;

  return (
    <IqCard padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 p-4 pb-2 sm:p-5 sm:pb-2">
        <div>
          <CardEyebrow>{t("routes.review.liveExecutions")}</CardEyebrow>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("routes.review.liveExecutionsNote")}</p>
        </div>
        <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      {isLoading ? (
        <div className="p-4 pt-2 text-center text-sm text-muted-foreground sm:p-5 sm:pt-2">
          {t("routes.review.loadingExecutions")}
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {executions.map((execution) => (
            <ExecutionRow key={execution.id} execution={execution} />
          ))}
        </div>
      )}
    </IqCard>
  );
}

function ExecutionRow({ execution }: { execution: ExecutionRecord }) {
  const { t } = useTranslation();
  const isBuy = execution.side === "BUY";
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-5">
      <div className="flex min-w-[100px] flex-1 items-center gap-1.5">
        <span className="font-semibold">{baseSymbol(execution.symbol)}</span>
        {isBuy ? (
          <TrendingUp className="h-3.5 w-3.5 text-bullish" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-bearish" />
        )}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {execution.entry_type}
        </span>
      </div>

      <div className="text-right text-xs">
        <div className="num font-semibold">{formatMoney(execution.entry_price)}</div>
        <div className="text-[10px] text-muted-foreground">
          {t("routes.review.filledOf", { filled: execution.filled_quantity, total: execution.quantity })}
        </div>
      </div>

      <div className="text-right text-xs">
        <div className="num font-semibold">{execution.leverage}×</div>
        <div className="text-[10px] text-muted-foreground">
          {new Date(execution.created_at).toLocaleString()}
        </div>
      </div>

      <Badge
        variant="outline"
        className={cn("shrink-0 text-[10px]", executionStatusClass(execution.status))}
      >
        {executionStatusLabel(execution.status)}
      </Badge>
    </div>
  );
}

// ── Track record — forward returns ──────────────────────────────────────────

/** Fraction (0.0234 = +2.34%) formatted as a signed percent string. */
function formatFractionPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const pct = value * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(digits)}%`;
}

/** Ground-truth forward-return track record — see `forward_return` table (engine/smc worker). */
function TrackRecordSection({ authenticated }: { authenticated: boolean }) {
  const { t } = useTranslation();
  const { data } = useForwardReturnEvidence();
  const horizons = data?.horizons ?? [];

  if (!authenticated || horizons.length === 0) return null;

  return (
    <IqCard padded={false} className="overflow-hidden">
      <div className="p-4 pb-2 sm:p-5 sm:pb-2">
        <CardEyebrow>{t("routes.review.trackRecord")}</CardEyebrow>
        <p className="mt-1 text-[11px] text-muted-foreground">{t("routes.review.trackRecordNote")}</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("routes.review.colHorizon")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colN")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colAvg")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colMedian")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colWinPct")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colBest")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colWorst")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {horizons.map((h) => (
            <TrackRecordRow key={h.horizon} horizon={h} />
          ))}
        </TableBody>
      </Table>
    </IqCard>
  );
}

function TrackRecordRow({ horizon: h }: { horizon: HorizonEvidence }) {
  const { t } = useTranslation();
  return (
    <TableRow>
      <TableCell className="font-medium uppercase">
        {h.horizon}
        {h.insufficient && (
          <Badge variant="outline" className="ml-2 border-warning/30 text-warning text-[9px]">
            {t("routes.review.insufficient")}
          </Badge>
        )}
      </TableCell>
      <TableCell className="num text-right">{h.n}</TableCell>
      <TableCell
        className={cn(
          "num text-right",
          !h.insufficient && h.avgR !== null && (h.avgR >= 0 ? "text-bullish" : "text-bearish"),
        )}
      >
        {h.insufficient ? "—" : formatFractionPercent(h.avgR)}
      </TableCell>
      <TableCell className="num text-right">
        {h.insufficient ? "—" : formatFractionPercent(h.medianR)}
      </TableCell>
      <TableCell className="num text-right">
        {h.insufficient || h.winRate === null ? "—" : `${(h.winRate * 100).toFixed(0)}%`}
      </TableCell>
      <TableCell className="num text-right text-bullish">
        {h.best
          ? `${baseSymbol(h.best.symbol)} ${formatFractionPercent(h.best.forwardReturn)}`
          : "—"}
      </TableCell>
      <TableCell className="num text-right text-bearish">
        {h.worst
          ? `${baseSymbol(h.worst.symbol)} ${formatFractionPercent(h.worst.forwardReturn)}`
          : "—"}
      </TableCell>
    </TableRow>
  );
}

// ── Analytics hero ───────────────────────────────────────────────────────────

function AnalyticsHero() {
  const { t } = useTranslation();
  const { analytics, isLoading } = useReviewAnalytics();

  if (isLoading) {
    return (
      <IqCard className="text-center text-sm text-muted-foreground py-6">
        {t("routes.review.loadingAnalytics")}
      </IqCard>
    );
  }
  if (!analytics || analytics.total_trades === 0) {
    return (
      <IqCard className="text-center text-sm text-muted-foreground py-6">
        {t("routes.review.syncToSeeAnalytics")}
      </IqCard>
    );
  }

  const rrValue =
    analytics.rr.mode === "r_multiple"
      ? analytics.rr.avg_r_multiple !== null
        ? `${analytics.rr.avg_r_multiple.toFixed(2)}R`
        : "—"
      : analytics.rr.payoff_ratio !== null
        ? `${analytics.rr.payoff_ratio.toFixed(2)}x`
        : "—";

  const bestSession = (["asia", "london", "new_york"] as const)
    .map((key) => ({ key, ...analytics.sessions[key] }))
    .filter((s) => s.n > 0)
    .sort((a, b) => b.win_rate - a.win_rate)[0];

  const sessionLabel: Record<string, string> = {
    asia: t("routes.review.sessionAsia"),
    london: t("routes.review.sessionLondon"),
    new_york: t("routes.review.sessionNewYork"),
  };

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
      <HeroTile
        icon={Target}
        eyebrow={t("routes.review.rr")}
        value={rrValue}
        secondary={analytics.rr.label}
        tone={
          analytics.rr.mode === "r_multiple"
            ? (analytics.rr.avg_r_multiple ?? 0) >= 0
              ? "bullish"
              : "bearish"
            : undefined
        }
      />
      <HeroTile
        icon={Trophy}
        eyebrow={t("routes.review.bestTrade")}
        value={analytics.best_trade ? baseSymbol(analytics.best_trade.symbol) : "—"}
        secondary={
          analytics.best_trade ? formatPnl(analytics.best_trade.realized_pnl) : t("routes.review.noData")
        }
        tone="bullish"
      />
      <HeroTile
        icon={Skull}
        eyebrow={t("routes.review.worstTrade")}
        value={analytics.worst_trade ? baseSymbol(analytics.worst_trade.symbol) : "—"}
        secondary={
          analytics.worst_trade ? formatPnl(analytics.worst_trade.realized_pnl) : t("routes.review.noData")
        }
        tone="bearish"
      />
      <HeroTile
        icon={Clock}
        eyebrow={t("routes.review.bestHour")}
        value={
          analytics.time_range
            ? `${pad2(analytics.time_range.start_hour_utc)}:00–${pad2(analytics.time_range.end_hour_utc)}:00 UTC`
            : "—"
        }
        secondary={
          analytics.time_range
            ? t("routes.review.winRateN", {
                pct: formatPercent(analytics.time_range.win_rate, 0),
                n: analytics.time_range.sample_size,
              })
            : bestSession
              ? t("routes.review.sessionStrongest", { session: sessionLabel[bestSession.key] })
              : t("routes.review.notEnoughData")
        }
      />
      <HeroTile
        icon={AlarmClock}
        eyebrow={t("routes.review.worstHour")}
        value={
          analytics.worst_time_range
            ? `${pad2(analytics.worst_time_range.start_hour_utc)}:00–${pad2(analytics.worst_time_range.end_hour_utc)}:00 UTC`
            : "—"
        }
        secondary={
          analytics.worst_time_range
            ? t("routes.review.winRateN", {
                pct: formatPercent(analytics.worst_time_range.win_rate, 0),
                n: analytics.worst_time_range.sample_size,
              })
            : t("routes.review.notEnoughData")
        }
        tone="bearish"
      />
      <HeroTile
        icon={Sparkles}
        eyebrow={t("routes.review.styleVerdict")}
        value={
          analytics.style.recommended
            ? analytics.style.recommended.charAt(0).toUpperCase() +
              analytics.style.recommended.slice(1)
            : t("routes.review.inconclusive")
        }
        secondary={
          analytics.style.recommended
            ? `${analytics.style.confidence === "ok" ? t("routes.review.confident") : t("routes.review.lowConfidence")} · ${analytics.style.data_quality}`
            : analytics.style.data_quality
        }
        badge={analytics.style.confidence}
      />
    </div>
  );
}

function HeroTile({
  icon: Icon,
  eyebrow,
  value,
  secondary,
  tone,
  badge,
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  value: string;
  secondary?: string;
  tone?: "bullish" | "bearish";
  badge?: "low" | "ok";
}) {
  return (
    <IqCard className="flex flex-col gap-1.5 p-3">
      <div className="flex items-center justify-between">
        <CardEyebrow>{eyebrow}</CardEyebrow>
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div
        className={cn(
          "num text-lg font-semibold leading-tight",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value}
      </div>
      {secondary && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {badge && (
            <Badge
              variant="outline"
              className={cn(
                "px-1 py-0 text-[9px]",
                badge === "ok"
                  ? "border-bullish/30 text-bullish"
                  : "border-warning/30 text-warning",
              )}
            >
              {badge}
            </Badge>
          )}
          <span className="truncate">{secondary}</span>
        </div>
      )}
    </IqCard>
  );
}

// ── Style bucket table ───────────────────────────────────────────────────────

function StyleBucketTable() {
  const { t } = useTranslation();
  const { analytics } = useReviewAnalytics();
  if (!analytics || analytics.total_trades === 0) return null;

  const rows = (["scalp", "intraday", "swing"] as const).map((key) => ({
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    ...analytics.style.buckets[key],
  }));

  return (
    <IqCard padded={false} className="overflow-hidden">
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <CardEyebrow>{t("routes.review.styleBreakdown")}</CardEyebrow>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("routes.review.colStyle")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colTrades")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colWinRate")}</TableHead>
            <TableHead className="text-right">{t("routes.review.colExpectancy")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.key}
              className={cn(analytics.style.recommended === row.key && "bg-info-soft/40")}
            >
              <TableCell className="font-medium">
                {row.label}
                {analytics.style.recommended === row.key && (
                  <Badge variant="outline" className="ml-2 border-info/30 text-info text-[10px]">
                    {t("routes.review.recommended")}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="num text-right">{row.n}</TableCell>
              <TableCell className="num text-right">
                {row.n > 0 ? formatPercent(row.win_rate, 0) : "—"}
              </TableCell>
              <TableCell
                className={cn("num text-right", pnlTone(row.n > 0 ? row.expectancy : null))}
              >
                {row.n > 0 ? formatPnl(row.expectancy) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </IqCard>
  );
}

// ── Trade row + inline AI review ────────────────────────────────────────────

function TradeReviewRow({
  trade,
  allTrades,
  aiConfigured,
}: {
  trade: ReviewTrade;
  allTrades: ReviewTrade[];
  aiConfigured: boolean;
}) {
  const { t } = useTranslation();
  const { data: review, isLoading: reviewLoading } = useTradeReview(trade.id);
  const generate = useGenerateTradeReview();

  const handleGenerate = () => {
    generate.mutate({ trade, allTrades, mode: "normal" });
  };

  return (
    <IqCard className="space-y-2.5 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <AssetIcon ticker={baseSymbol(trade.symbol)} className="h-8 w-8 text-sm" />

        <div className="min-w-[110px] flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold">{baseSymbol(trade.symbol)}</span>
            {trade.side === "LONG" ? (
              <TrendingUp className="h-3.5 w-3.5 text-bullish" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-bearish" />
            )}
            {trade.leverage > 1 && (
              <span className="text-[10px] font-semibold text-warning px-1 rounded border border-warning/30 bg-warning-soft">
                {trade.leverage}×
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t("routes.review.closed", {
              date: trade.closed_at
                ? new Date(trade.closed_at).toLocaleString()
                : t("routes.review.recently"),
            })}
          </div>
        </div>

        <div className="text-right">
          <div className={cn("num font-semibold", pnlTone(trade.realized_pnl))}>
            {formatPnl(trade.realized_pnl)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {formatPercent(trade.roi_percent)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Metric label={t("routes.review.entry")} value={formatMoney(trade.entry_price)} />
        <Metric label={t("routes.review.exit")} value={formatMoney(trade.exit_price)} />
        <Metric label={t("routes.review.qty")} value={String(trade.quantity)} />
        <Metric label={t("routes.review.closeTrigger")} value={trade.close_trigger ?? "—"} />
      </div>

      <div className="border-t border-border/40 pt-2">
        {reviewLoading ? (
          <p className="text-xs text-muted-foreground">{t("routes.review.checkingExistingReview")}</p>
        ) : review ? (
          <TradeReviewCard review={review} />
        ) : null}

        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant={review ? "outline" : "default"}
            className="gap-1.5 text-xs h-7 px-2"
            onClick={handleGenerate}
            disabled={!aiConfigured || generate.isPending}
          >
            <Sparkles className="h-3 w-3" />
            {generate.isPending
              ? t("routes.review.generating")
              : review
                ? t("routes.review.regenerateAiReview")
                : t("routes.review.generateAiReview")}
          </Button>
          {!aiConfigured && (
            <span className="text-[11px] text-muted-foreground">
              {t("routes.review.configureAiProviderPrefix")}{" "}
              <Link to="/settings" className="text-info underline-offset-2 hover:underline">
                {t("common.settings")}
              </Link>{" "}
              {t("routes.review.configureAiProviderSuffix")}
            </span>
          )}
        </div>
        {generate.isError && (
          <p className="mt-1 text-xs text-destructive">{(generate.error as Error).message}</p>
        )}
      </div>
    </IqCard>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="num font-semibold">{value}</div>
    </div>
  );
}

function TradeReviewCard({ review }: { review: TradeReview }) {
  const { t } = useTranslation();
  const sections = SECTION_ORDER.map((type) => review.sections.find((s) => s.type === type)).filter(
    (s): s is NonNullable<typeof s> => Boolean(s && s.content),
  );

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("shrink-0", GRADE_TONE[review.grade])}>
            {review.grade}
          </Badge>
          <span className="text-sm font-semibold">{review.headline}</span>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
          {review.severity_tier}
        </Badge>
      </div>

      <p className="text-xs italic text-muted-foreground">{review.one_liner}</p>

      {sections.map((s) => (
        <div key={s.type}>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {s.title}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed">{s.content}</p>
        </div>
      ))}

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("routes.review.suggestion")}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed">{review.suggestion}</p>
      </div>

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("routes.review.closingQuestion")}
        </div>
        <p className="mt-0.5 text-xs italic leading-relaxed">{review.closing_question}</p>
      </div>

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("routes.review.coachingNote")}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed">{review.coaching_note}</p>
      </div>

      {review.data_flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {review.data_flags.map((flag, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning"
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              {flag}
            </span>
          ))}
        </div>
      )}

      {review.annotations && review.annotations.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("routes.review.chartAnnotations")}
          </div>
          <ul className="mt-1 space-y-1">
            {review.annotations.map((a) => (
              <li key={a.id} className="text-xs leading-relaxed">
                <span className="font-semibold uppercase text-[10px] text-muted-foreground">
                  [{a.position}]
                </span>{" "}
                <span className="font-medium">{a.title}</span> — {a.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
