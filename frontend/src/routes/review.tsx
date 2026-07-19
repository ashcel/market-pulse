import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
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
import {
  useBybitKeyStatus,
  useGenerateTradeReview,
  useReviewAnalytics,
  useReviewTrades,
  useSyncBybit,
  useTradeReview,
} from "@/hooks/useReview";
import { resolveAiConfig } from "@/lib/ai/providers";
import type { ReviewTrade, TradeReview } from "@/lib/review/types";
import { formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { useAiSettingsStore } from "@/stores/ai-settings";

export const Route = createFileRoute("/review")({
  head: () => ({
    meta: [
      { title: "Trade Review — Market Pulse" },
      {
        name: "description",
        content: "Sync your Bybit trade history and generate AI-powered per-trade reviews.",
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
const SIDE_FILTERS: { label: string; value: SideFilter }[] = [
  { label: "All", value: "all" },
  { label: "Long", value: "LONG" },
  { label: "Short", value: "SHORT" },
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
  const [sideFilter, setSideFilter] = useState<SideFilter>("all");
  const { trades, authenticated, isLoading } = useReviewTrades();
  const aiSettings = useAiSettingsStore();
  const aiConfigured = resolveAiConfig(aiSettings) !== null;

  const filteredTrades =
    sideFilter === "all" ? trades : trades.filter((t) => t.side === sideFilter);

  return (
    <div className="space-y-5 pb-20 lg:pb-6">
      <PageHeader
        eyebrow="Trade Review"
        title="Trade Review"
        subtitle="Sync your Bybit history, see where your edge actually is, and get an honest per-trade AI review — generated in your browser with your own AI key."
      />

      <SyncCard authenticated={authenticated} />

      <LiveExecutionsSection />

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
                {f.label}
              </button>
            ))}
          </div>

          {isLoading ? (
            <IqCard className="text-center text-sm text-muted-foreground py-6">
              Loading trades…
            </IqCard>
          ) : filteredTrades.length === 0 ? (
            <IqCard className="text-center text-sm text-muted-foreground py-6">
              {trades.length === 0
                ? "No trades synced yet — connect Bybit above and hit Sync now."
                : `No ${sideFilter.toLowerCase()} trades.`}
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
  return (
    <IqCard className="space-y-2 text-center text-sm text-muted-foreground">
      <p>Trade Review lives on the server — sign in to connect Bybit and review your trades.</p>
      <p>
        <Link to="/login" className="font-medium text-info underline-offset-2 hover:underline">
          Sign in
        </Link>{" "}
        to get started.
      </p>
    </IqCard>
  );
}

// ── Sync / connection card ──────────────────────────────────────────────────

function SyncCard({ authenticated }: { authenticated: boolean }) {
  const { connected, lastSyncedAt, isLoading } = useBybitKeyStatus();
  const sync = useSyncBybit();

  if (!authenticated) return null;

  return (
    <IqCard className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <CardEyebrow>Bybit Sync</CardEyebrow>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
              connected ? "bg-bullish-soft text-bullish" : "bg-muted text-muted-foreground",
            )}
          >
            {isLoading ? "Checking…" : connected ? "Connected" : "Not connected"}
          </span>
          {connected && (
            <span className="text-xs text-muted-foreground">
              {lastSyncedAt
                ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}`
                : "Never synced"}
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
          {sync.isPending ? "Syncing…" : "Sync now"}
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="text-xs" asChild>
          <Link to="/settings">Connect Bybit in Settings</Link>
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
  const { executions, authenticated, isLoading } = useExecutions();

  if (!authenticated) return null;
  if (!isLoading && executions.length === 0) return null;

  return (
    <IqCard padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 p-4 pb-2 sm:p-5 sm:pb-2">
        <div>
          <CardEyebrow>Live Executions · Binance testnet</CardEyebrow>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Order-placement records from confirmed executions — not PnL-settled trades yet.
          </p>
        </div>
        <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      {isLoading ? (
        <div className="p-4 pt-2 text-center text-sm text-muted-foreground sm:p-5 sm:pt-2">
          Loading executions…
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
          {execution.filled_quantity}/{execution.quantity} filled
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

// ── Analytics hero ───────────────────────────────────────────────────────────

function AnalyticsHero() {
  const { analytics, isLoading } = useReviewAnalytics();

  if (isLoading) {
    return (
      <IqCard className="text-center text-sm text-muted-foreground py-6">Loading analytics…</IqCard>
    );
  }
  if (!analytics || analytics.total_trades === 0) {
    return (
      <IqCard className="text-center text-sm text-muted-foreground py-6">
        Sync trades to see your RR, best/worst trades, and edge by time of day.
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
    asia: "Asia",
    london: "London",
    new_york: "New York",
  };

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
      <HeroTile
        icon={Target}
        eyebrow="RR"
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
        eyebrow="Best trade"
        value={analytics.best_trade ? baseSymbol(analytics.best_trade.symbol) : "—"}
        secondary={analytics.best_trade ? formatPnl(analytics.best_trade.realized_pnl) : "No data"}
        tone="bullish"
      />
      <HeroTile
        icon={Skull}
        eyebrow="Worst trade"
        value={analytics.worst_trade ? baseSymbol(analytics.worst_trade.symbol) : "—"}
        secondary={
          analytics.worst_trade ? formatPnl(analytics.worst_trade.realized_pnl) : "No data"
        }
        tone="bearish"
      />
      <HeroTile
        icon={Clock}
        eyebrow="Best hour"
        value={
          analytics.time_range
            ? `${pad2(analytics.time_range.start_hour_utc)}:00–${pad2(analytics.time_range.end_hour_utc)}:00 UTC`
            : "—"
        }
        secondary={
          analytics.time_range
            ? `${formatPercent(analytics.time_range.win_rate, 0)} win rate · n=${analytics.time_range.sample_size}`
            : bestSession
              ? `${sessionLabel[bestSession.key]} session strongest`
              : "Not enough data yet"
        }
      />
      <HeroTile
        icon={AlarmClock}
        eyebrow="Worst hour"
        value={
          analytics.worst_time_range
            ? `${pad2(analytics.worst_time_range.start_hour_utc)}:00–${pad2(analytics.worst_time_range.end_hour_utc)}:00 UTC`
            : "—"
        }
        secondary={
          analytics.worst_time_range
            ? `${formatPercent(analytics.worst_time_range.win_rate, 0)} win rate · n=${analytics.worst_time_range.sample_size}`
            : "Not enough data yet"
        }
        tone="bearish"
      />
      <HeroTile
        icon={Sparkles}
        eyebrow="Style verdict"
        value={
          analytics.style.recommended
            ? analytics.style.recommended.charAt(0).toUpperCase() +
              analytics.style.recommended.slice(1)
            : "Inconclusive"
        }
        secondary={
          analytics.style.recommended
            ? `${analytics.style.confidence === "ok" ? "Confident" : "Low confidence"} · ${analytics.style.data_quality}`
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
        <CardEyebrow>Style breakdown</CardEyebrow>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Style</TableHead>
            <TableHead className="text-right">Trades</TableHead>
            <TableHead className="text-right">Win rate</TableHead>
            <TableHead className="text-right">Expectancy</TableHead>
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
                    Recommended
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
            Closed {trade.closed_at ? new Date(trade.closed_at).toLocaleString() : "recently"}
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
        <Metric label="Entry" value={formatMoney(trade.entry_price)} />
        <Metric label="Exit" value={formatMoney(trade.exit_price)} />
        <Metric label="Qty" value={String(trade.quantity)} />
        <Metric label="Close trigger" value={trade.close_trigger ?? "—"} />
      </div>

      <div className="border-t border-border/40 pt-2">
        {reviewLoading ? (
          <p className="text-xs text-muted-foreground">Checking for an existing review…</p>
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
              ? "Generating…"
              : review
                ? "Regenerate AI review"
                : "Generate AI review"}
          </Button>
          {!aiConfigured && (
            <span className="text-[11px] text-muted-foreground">
              Configure an AI provider in{" "}
              <Link to="/settings" className="text-info underline-offset-2 hover:underline">
                Settings
              </Link>{" "}
              first.
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
          Suggestion
        </div>
        <p className="mt-0.5 text-xs leading-relaxed">{review.suggestion}</p>
      </div>

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Closing question
        </div>
        <p className="mt-0.5 text-xs italic leading-relaxed">{review.closing_question}</p>
      </div>

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Coaching note
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
            Chart annotations
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
