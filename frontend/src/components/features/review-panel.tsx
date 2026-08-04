import { Link } from "@tanstack/react-router";
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
  ChevronDown,
} from "lucide-react";

import { AssetIcon } from "@/components/features/asset-icon";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
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
import {
  shown,
  useForensicsList,
  useTradeForensics,
  why,
  type MetricKey,
  type MetricValue,
  type TradeForensics,
} from "@/hooks/useForensics";
import {
  useBinanceKeyStatus,
  useGenerateTradeReview,
  useReviewAnalytics,
  useReviewTrades,
  useSyncBinance,
  useTradeReview,
} from "@/hooks/useReview";
import { resolveAiConfig } from "@/lib/ai/providers";
import type { Analytics, ReviewTrade, TradeReview } from "@/lib/review/types";
import { formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { useAiSettingsStore } from "@/stores/ai-settings";

// Extracted from the former `/review` route body (IA-REDESIGN-2026-07-23
// §4.3 Journal merge). `ReviewPanel` is the Habits tab content on
// `/journal`, reused unchanged as the `/review` thin wrapper's body — the
// synced-trade analytics (RR, best/worst hours, style-fit) framed as
// behavior habits per the task's Habits description.

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

/**
 * Local-timezone abbreviation for display (WIB/WITA/WIT for Indonesian
 * zones, otherwise the browser's short tz name, falling back to "Local").
 */
function localTzLabel(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const idMap: Record<string, string> = {
      "Asia/Jakarta": "WIB",
      "Asia/Pontianak": "WIB",
      "Asia/Makassar": "WITA",
      "Asia/Jayapura": "WIT",
    };
    if (zone in idMap) return idMap[zone];
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "Local";
  } catch {
    return "Local";
  }
}

/** Convert a 0–23 UTC hour to the browser's local hour. */
function utcHourToLocal(hour: number): number {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return d.getHours();
}

/** Format a UTC hour range as a local-time window, e.g. "09:00–10:00 WIB". */
function formatLocalHourRange(startHourUtc: number, endHourUtc: number): string {
  return `${pad2(utcHourToLocal(startHourUtc))}:00–${pad2(utcHourToLocal(endHourUtc))}:00 ${localTzLabel()}`;
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

/**
 * Purely descriptive "what this says about your trading" line — computed
 * from the same counts/rates `AnalyticsHero` already renders, no new stat,
 * no AI call. Per M3 rule (milestones/M3-per-trade-forensics.md): counts and
 * distributions only, never a cohort/edge claim ("you have edge when…").
 */
function habitsSummaryLine(analytics: Analytics | null | undefined): string | null {
  if (!analytics || analytics.total_trades === 0) return null;

  const parts: string[] = [
    `${analytics.total_trades} synced trade${analytics.total_trades === 1 ? "" : "s"} reviewed so far.`,
  ];

  if (analytics.time_range && analytics.time_range.sample_size >= 3) {
    parts.push(
      `Best window observed: ${formatLocalHourRange(analytics.time_range.start_hour_utc, analytics.time_range.end_hour_utc)} ` +
        `(${formatPercent(analytics.time_range.win_rate, 0)} win rate across ${analytics.time_range.sample_size} trades).`,
    );
  }

  if (analytics.worst_time_range && analytics.worst_time_range.sample_size >= 3) {
    parts.push(
      `Weakest window: ${formatLocalHourRange(analytics.worst_time_range.start_hour_utc, analytics.worst_time_range.end_hour_utc)} ` +
        `(${formatPercent(analytics.worst_time_range.win_rate, 0)} win rate across ${analytics.worst_time_range.sample_size} trades).`,
    );
  }

  const recommended = analytics.style.recommended;
  if (
    (recommended === "scalp" || recommended === "intraday" || recommended === "swing") &&
    analytics.style.confidence === "ok"
  ) {
    const bucket = analytics.style.buckets[recommended];
    parts.push(
      `${recommended.charAt(0).toUpperCase() + recommended.slice(1)} trades show the highest win rate of your three styles so far (${formatPercent(bucket.win_rate, 0)} across ${bucket.n}).`,
    );
  }

  return parts.join(" ");
}

// ── Habits tab / `/review` thin-wrapper body ──────────────────────────────────

export function ReviewPanel() {
  return (
    <div className="space-y-5">
      <LiveTab />
    </div>
  );
}

/** Live sub-tab: synced-trade analytics framed as behavior habits. */
function LiveTab() {
  const [sideFilter, setSideFilter] = useState<SideFilter>("all");
  const { trades, authenticated, isLoading } = useReviewTrades();
  const aiSettings = useAiSettingsStore();
  const aiConfigured = resolveAiConfig(aiSettings) !== null;

  const filteredTrades =
    sideFilter === "all" ? trades : trades.filter((t) => t.side === sideFilter);

  return (
    <div className="space-y-5">
      <SyncCard authenticated={authenticated} />

      {!authenticated ? (
        <NotSignedInCard />
      ) : (
        <>
          <HabitsSummary />
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
                ? "No trades synced yet — connect Binance above and hit Sync now."
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
          <ForensicsSummary />
        </>
      )}
    </div>
  );
}

function NotSignedInCard() {
  return (
    <IqCard className="space-y-2 text-center text-sm text-muted-foreground">
      <p>Trade Review lives on the server — sign in to connect Binance and review your trades.</p>
      <p>
        <Link to="/login" className="font-medium text-info underline-offset-2 hover:underline">
          Sign in
        </Link>{" "}
        to get started.
      </p>
    </IqCard>
  );
}

/** The short, descriptive habits framing line — see `habitsSummaryLine`. */
function HabitsSummary() {
  const { analytics } = useReviewAnalytics();
  const line = habitsSummaryLine(analytics);
  if (!line) return null;

  return (
    <IqCard className="space-y-1">
      <CardEyebrow>What this says about your trading</CardEyebrow>
      <p className="text-xs leading-relaxed text-muted-foreground">{line}</p>
    </IqCard>
  );
}

// ── Sync / connection card ──────────────────────────────────────────────────

function SyncCard({ authenticated }: { authenticated: boolean }) {
  const { connected, lastSyncedAt, isLoading } = useBinanceKeyStatus();
  const sync = useSyncBinance();

  if (!authenticated) return null;

  return (
    <IqCard className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <CardEyebrow>Binance Sync</CardEyebrow>
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
          <Link to="/settings">Connect Binance in Settings</Link>
        </Button>
      )}
    </IqCard>
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
            ? formatLocalHourRange(
                analytics.time_range.start_hour_utc,
                analytics.time_range.end_hour_utc,
              )
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
            ? formatLocalHourRange(
                analytics.worst_time_range.start_hour_utc,
                analytics.worst_time_range.end_hour_utc,
              )
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
  const [forensicsOpen, setForensicsOpen] = useState(false);
  const forensics = useTradeForensics(trade.id, forensicsOpen);
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
        <button
          type="button"
          onClick={() => setForensicsOpen((open) => !open)}
          aria-expanded={forensicsOpen}
          className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <span>Forensics</span>
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", forensicsOpen && "rotate-180")}
          />
        </button>
        {forensicsOpen && (
          <div className="mt-2">
            {forensics.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading forensics…</p>
            ) : forensics.isError ? (
              <p className="text-xs text-destructive">Forensics could not be loaded.</p>
            ) : forensics.data ? (
              <ForensicsDashboard trade={trade} forensics={forensics.data} />
            ) : (
              <p className="text-xs text-muted-foreground">
                No forensics available for this trade.
              </p>
            )}
          </div>
        )}
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

/**
 * An unsupported measurement always renders its reason. Never `0`, `—`, `N/A`,
 * or an omitted field — that is honesty rule R3 in docs/forensics-definitions.md.
 */
function Unavailable({ reason }: { reason: string }) {
  return (
    <Badge variant="outline" className="border-warning/30 bg-warning-soft text-[9px] text-warning">
      {reason.replaceAll("_", " ")}
    </Badge>
  );
}

function formatR(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function formatLatency(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/** Renders the value when the measurement is available, its reason when not. */
function MetricCell({
  label,
  forensics,
  metricKey,
  format,
}: {
  label: string;
  forensics: TradeForensics;
  metricKey: MetricKey;
  format: (value: number) => string;
}) {
  const metric = shown(forensics, metricKey);
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {metric ? (
        <div className="num font-semibold">{format(metric.value)}</div>
      ) : (
        <Unavailable reason={why(forensics, metricKey)} />
      )}
    </div>
  );
}

function ForensicsDashboard({
  trade,
  forensics,
}: {
  trade: ReviewTrade;
  forensics: TradeForensics;
}) {
  const maePercent = shown(forensics, "mae_percent");
  const mfePercent = shown(forensics, "mfe_percent");
  const maePrice = shown(forensics, "mae_price");
  const mfePrice = shown(forensics, "mfe_price");
  const efficiency = shown(forensics, "exit_efficiency");
  const latency = shown(forensics, "reentry_latency_seconds");
  const sizeRatio = shown(forensics, "sizing_size_ratio");
  const inflated = [maePercent, mfePercent].some((m) => m?.flags.includes("boundary_inflated"));

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-surface/60 p-2.5">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1.5fr)_1fr_1fr]">
        <div className="rounded-md border border-border/50 p-2">
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="font-semibold">
              Excursion from entry {formatMoney(trade.entry_price)}
            </span>
            {forensics.kline_interval && (
              <span className="text-muted-foreground">{forensics.kline_interval} candles</span>
            )}
          </div>
          <div className="mt-2 grid grid-cols-[42px_1fr_auto] items-center gap-1.5 text-[10px]">
            <span className="text-bearish">MAE</span>
            <div className="flex h-1.5 justify-end overflow-hidden rounded-full bg-muted">
              {maePercent && (
                <div
                  className="rounded-full bg-bearish"
                  style={{ width: `${Math.min(Math.abs(maePercent.value), 100)}%` }}
                />
              )}
            </div>
            <span className="num min-w-[90px] text-right">
              {maePercent && maePrice ? (
                `${formatMoney(maePrice.value)} (${formatPercent(maePercent.value)})`
              ) : (
                <Unavailable reason={why(forensics, "mae_percent")} />
              )}
            </span>
            <span className="text-bullish">MFE</span>
            <div className="relative h-1.5 overflow-visible rounded-full bg-muted">
              {mfePercent && (
                <div
                  className="h-full rounded-full bg-bullish"
                  style={{ width: `${Math.min(Math.abs(mfePercent.value), 100)}%` }}
                />
              )}
              {efficiency && (
                <span
                  className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground"
                  style={{ left: `${Math.max(0, Math.min(efficiency.value, 100))}%` }}
                  title={`Exit at ${efficiency.value.toFixed(0)}% of favorable excursion`}
                />
              )}
            </div>
            <span className="num min-w-[90px] text-right">
              {mfePercent && mfePrice ? (
                `${formatMoney(mfePrice.value)} (${formatPercent(mfePercent.value)})`
              ) : (
                <Unavailable reason={why(forensics, "mfe_percent")} />
              )}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>Exit {formatMoney(trade.exit_price)}</span>
            <span>·</span>
            {efficiency ? (
              <span>{efficiency.value.toFixed(0)}% efficiency</span>
            ) : (
              <Unavailable reason={why(forensics, "exit_efficiency")} />
            )}
            {inflated && forensics.boundary_inflation_bound_pct !== null && (
              <>
                <span>·</span>
                <span title="Both boundary candles are included whole, so the excursion is over-stated by at most this much.">
                  ±{forensics.boundary_inflation_bound_pct.toFixed(2)}% boundary
                </span>
              </>
            )}
            {forensics.partial_close_suspected && (
              <>
                <span>·</span>
                <Unavailable reason="partial close suspected" />
              </>
            )}
          </div>
        </div>

        <div className="rounded-md border border-border/50 p-2">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Stop discipline
            </span>
            <span className="text-[9px] text-muted-foreground">{forensics.stop_evidence}</span>
          </div>
          {forensics.discipline_breach && (
            <p className="mt-1 text-[10px] font-medium text-bearish">
              Liquidated — no effective stop
            </p>
          )}
          <div className="mt-1.5 grid grid-cols-2 gap-1 text-[10px]">
            <MetricCell
              label="Slippage"
              forensics={forensics}
              metricKey="slippage_adverse"
              format={formatMoney}
            />
            <MetricCell
              label="Slippage R"
              forensics={forensics}
              metricKey="slippage_adverse_r"
              format={formatR}
            />
            <MetricCell
              label="Past stop"
              forensics={forensics}
              metricKey="violation_depth_r"
              format={formatR}
            />
            <MetricCell
              label="Realized"
              forensics={forensics}
              metricKey="realized_r"
              format={formatR}
            />
          </div>
        </div>

        <div className="rounded-md border border-border/50 p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Re-entry
          </div>
          <div className="mt-1.5 space-y-1 text-[11px]">
            {latency ? (
              <>
                <p className="font-medium">
                  Re-entered after {formatLatency(latency.value)}
                  {forensics.reentry_after_loss ? " (after a loss)" : ""}
                </p>
                <p className="text-muted-foreground">
                  {forensics.reentry_same_direction
                    ? "Same direction as previous trade"
                    : "Opposite direction to previous trade"}
                </p>
              </>
            ) : (
              <Unavailable reason={why(forensics, "reentry_latency_seconds")} />
            )}
          </div>
          <div className="mt-1.5 border-t border-border/40 pt-1.5 text-[10px]">
            {sizeRatio ? (
              <p className="text-muted-foreground">
                {sizeRatio.value.toFixed(2)}× your median{" "}
                {forensics.sizing_mode === "risk_based" ? "risk" : "notional"} (n=
                {forensics.sizing_n})
              </p>
            ) : (
              <Unavailable reason={why(forensics, "sizing_size_ratio")} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ForensicsSummary() {
  const { data, isLoading, isError } = useForensicsList(1, 100);
  if (isLoading) return null;
  if (isError || !data || data.data.length === 0) return null;

  const rows = data.data;
  const available = (key: MetricKey) =>
    rows
      .map((row) => shown(row, key))
      .filter((m): m is MetricValue & { value: number } => m !== null);
  const average = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  // Counts and distributions only — never a win rate, never an expectancy.
  const stats: [string, MetricKey, "bullish" | "bearish" | undefined][] = [
    ["Avg MAE", "mae_percent", "bearish"],
    ["Avg MFE", "mfe_percent", "bullish"],
    ["Avg exit efficiency", "exit_efficiency", undefined],
  ];

  return (
    <IqCard className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <CardEyebrow>Forensics summary</CardEyebrow>
        <span className="text-[10px] text-muted-foreground">
          {rows.length} of {data.meta.total} trades loaded
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {stats.map(([label, key, tone]) => {
          const measured = available(key);
          return (
            <SummaryStat
              key={key}
              label={label}
              value={measured.length ? formatPercent(average(measured.map((m) => m.value))) : null}
              coverage={`${measured.length} of ${rows.length} measured`}
              tone={tone}
            />
          );
        })}
      </div>
      <Histogram
        label="Exit efficiency"
        values={available("exit_efficiency").map((m) => m.value)}
        bins={[0, 20, 40, 60, 80, 100]}
        unmeasured={rows.length - available("exit_efficiency").length}
      />
      <Histogram
        label="MAE (% of entry)"
        values={available("mae_percent").map((m) => m.value)}
        bins={[0, 1, 2, 5, 10]}
        unmeasured={rows.length - available("mae_percent").length}
      />
      <p className="text-[10px] text-muted-foreground">
        Counts of what was measured. Nothing here is a win rate, a probability, or an expectancy.
      </p>
    </IqCard>
  );
}

/**
 * Counts per bin — the only aggregate shape the honesty rules allow for a
 * cohort. `unmeasured` is shown so the coverage hole is never invisible.
 */
function Histogram({
  label,
  values,
  bins,
  unmeasured,
}: {
  label: string;
  values: number[];
  bins: number[];
  unmeasured: number;
}) {
  const counts = bins.map((lower, index) => {
    const upper = bins[index + 1];
    const inBin = values.filter(
      (value) => value >= lower && (upper === undefined || value < upper),
    );
    return { lower, upper, count: inBin.length };
  });
  const peak = Math.max(1, ...counts.map((bin) => bin.count));

  return (
    <div className="rounded-md border border-border/60 bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground">
          n={values.length}
          {unmeasured > 0 ? ` · ${unmeasured} not measured` : ""}
        </span>
      </div>
      <div className="mt-1.5 flex items-end gap-1">
        {counts.map((bin) => (
          <div key={bin.lower} className="flex flex-1 flex-col items-center gap-0.5">
            <span className="num text-[9px] text-muted-foreground">{bin.count}</span>
            <div
              className="w-full rounded-sm bg-info/60"
              style={{ height: `${Math.max(2, (bin.count / peak) * 28)}px` }}
            />
            <span className="text-[9px] text-muted-foreground">
              {bin.upper === undefined ? `${bin.lower}+` : `${bin.lower}–${bin.upper}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  coverage,
  tone,
}: {
  label: string;
  value: string | null;
  coverage: string;
  tone?: "bullish" | "bearish";
}) {
  return (
    <div className="rounded-md border border-border/60 bg-surface p-2.5">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 text-sm font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value ?? <Unavailable reason="no measured trades" />}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{coverage}</div>
    </div>
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

      {review.unsupported_claims && review.unsupported_claims.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning-soft p-2 text-xs text-warning">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="h-3.5 w-3.5" />
            Unsupported numeric claims detected
          </div>
          <p className="mt-1 text-[11px]">
            AI claims could not be matched to this trade's forensics.
          </p>
        </div>
      )}

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
