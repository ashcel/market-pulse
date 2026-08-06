import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Plus, Trash2, TrendingDown, TrendingUp, X, Check, DollarSign } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetIcon } from "@/components/features/asset-icon";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { PageHeader } from "@/components/features/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useTrades,
  useCreateTrade,
  useDeleteTrade,
  useCloseTrade,
  type Trade,
  type TradeCreate,
} from "@/hooks/useTrades";
import { useOpenTradesPnl, type OpenTradePnl } from "@/hooks/useOpenTradesPnl";
import { formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { requireSession } from "@/lib/auth/guard";

export const Route = createFileRoute("/trades")({
  beforeLoad: () => requireSession("/trades"),
  head: () => ({
    meta: [
      { title: "Positions & Journal — Market Pulse" },
      {
        name: "description",
        content:
          "Live open positions with real-time unrealized PnL, plus your closed-trade journal.",
      },
      { property: "og:title", content: "Positions & Journal — Market Pulse" },
      {
        property: "og:description",
        content: "Track running positions live and review your trade history.",
      },
    ],
  }),
  component: TradesPage,
});

type HistoryFilter = "all" | "closed" | "cancelled";
const HISTORY_FILTERS: { labelKey: string; value: HistoryFilter }[] = [
  { labelKey: "historyFilterAll", value: "all" },
  { labelKey: "historyFilterClosed", value: "closed" },
  { labelKey: "historyFilterCancelled", value: "cancelled" },
];

const STATUS_TONE: Record<Trade["status"], string> = {
  open: "border-info/30 bg-info-soft text-info",
  closed: "border-muted/30 bg-surface text-muted-foreground",
  cancelled: "border-muted/30 bg-surface text-muted-foreground",
};

const STATUS_LABEL_KEY: Record<Trade["status"], string> = {
  open: "statusOpen",
  closed: "statusClosed",
  cancelled: "statusCancelled",
};

function formatPnl(pnl: number | null): string {
  if (pnl === null) return "—";
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}${formatMoney(pnl)}`;
}

function formatPct(pct: number | null): string {
  if (pct === null) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function pnlTone(pnl: number | null): string {
  if (pnl === null) return "text-muted-foreground";
  return pnl >= 0 ? "text-bullish" : "text-bearish";
}

// ── Live indicator ────────────────────────────────────────────────────────────

function LiveDot({ live }: { live: boolean }) {
  if (!live) {
    return <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" />;
  }
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bullish opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-bullish" />
    </span>
  );
}

// ── Summary Statistics (journal / history) ────────────────────────────────────

function summarizeTrades(trades: Trade[]) {
  const closed = trades.filter((t) => t.status === "closed");
  const open = trades.filter((t) => t.status === "open");
  const winners = closed.filter((t) => (t.pnl ?? 0) > 0);
  const totalPnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const winRate = closed.length ? Math.round((winners.length / closed.length) * 100) : null;
  return {
    total: trades.length,
    open: open.length,
    closed: closed.length,
    winRate,
    totalPnl: closed.length ? Math.round(totalPnl * 100) / 100 : null,
  };
}

// ── New Trade Form ────────────────────────────────────────────────────────────

interface NewTradeFormProps {
  onClose: () => void;
}

function NewTradeForm({ onClose }: NewTradeFormProps) {
  const { t } = useTranslation();
  const createTrade = useCreateTrade();
  const [form, setForm] = useState<{
    symbol: string;
    direction: "long" | "short";
    entry_price: string;
    quantity: string;
    leverage: string;
    strategy: string;
    notes: string;
  }>({
    symbol: "BTC",
    direction: "long",
    entry_price: "",
    quantity: "",
    leverage: "1",
    strategy: "",
    notes: "",
  });

  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    const entryPrice = Number(form.entry_price);
    const quantity = Number(form.quantity);
    const leverage = Number(form.leverage);

    if (!form.symbol.trim()) {
      setError(t("routes.trades.symbolRequired"));
      return;
    }
    if (!entryPrice || entryPrice <= 0) {
      setError(t("routes.trades.entryPricePositive"));
      return;
    }
    if (!quantity || quantity <= 0) {
      setError(t("routes.trades.quantityPositive"));
      return;
    }

    const payload: TradeCreate = {
      symbol: form.symbol.toUpperCase(),
      direction: form.direction,
      entry_price: entryPrice,
      quantity,
      leverage: leverage || 1,
      strategy: form.strategy || null,
      notes: form.notes || null,
      opened_at: new Date().toISOString(),
    };

    try {
      await createTrade.mutateAsync(payload);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <IqCard className="space-y-4">
      <div className="flex items-center justify-between">
        <CardEyebrow>{t("routes.trades.newTradeTitle")}</CardEyebrow>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("routes.trades.symbol")}
          </label>
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm font-semibold uppercase"
            placeholder="BTC"
            value={form.symbol}
            onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("routes.trades.direction")}
          </label>
          <div className="flex gap-1">
            {(["long", "short"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setForm((f) => ({ ...f, direction: d }))}
                className={cn(
                  "flex-1 rounded-md border px-3 py-2 text-sm font-semibold transition-colors",
                  form.direction === d
                    ? d === "long"
                      ? "border-bullish/30 bg-bullish-soft text-bullish"
                      : "border-bearish/30 bg-bearish-soft text-bearish"
                    : "border-border bg-surface text-muted-foreground hover:text-foreground",
                )}
              >
                {d === "long" ? t("routes.trades.long") : t("routes.trades.short")}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("routes.trades.entryPrice")}
          </label>
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder="50000"
            type="number"
            min="0"
            value={form.entry_price}
            onChange={(e) => setForm((f) => ({ ...f, entry_price: e.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("routes.trades.quantity")}
          </label>
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder="0.1"
            type="number"
            min="0"
            step="0.0001"
            value={form.quantity}
            onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("routes.trades.leverage")}
          </label>
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder="1"
            type="number"
            min="1"
            max="125"
            value={form.leverage}
            onChange={(e) => setForm((f) => ({ ...f, leverage: e.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("routes.trades.strategyOptional")}
          </label>
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder="e.g. SMC Scalp"
            value={form.strategy}
            onChange={(e) => setForm((f) => ({ ...f, strategy: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("routes.trades.notesOptional")}
        </label>
        <textarea
          className="border-input bg-background rounded-md border px-3 py-2 text-sm resize-none"
          placeholder={t("routes.trades.notesPlaceholder")}
          rows={2}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex gap-2 pt-1">
        <Button className="flex-1" onClick={handleSubmit} disabled={createTrade.isPending}>
          {createTrade.isPending ? t("routes.trades.loggingEllipsis") : t("routes.trades.logTrade")}
        </Button>
        <Button variant="outline" onClick={onClose}>
          {t("routes.trades.cancel")}
        </Button>
      </div>
    </IqCard>
  );
}

// ── Close Trade Form ──────────────────────────────────────────────────────────

function CloseTradeInline({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  const { t } = useTranslation();
  const closeTrade = useCloseTrade();
  const [exitPrice, setExitPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const previewPnl = (() => {
    const price = Number(exitPrice);
    if (!price || price <= 0) return null;
    const pnlPerUnit =
      trade.direction === "long" ? price - trade.entry_price : trade.entry_price - price;
    return Math.round(pnlPerUnit * trade.quantity * trade.leverage * 100) / 100;
  })();

  const handleClose = () => {
    setError(null);
    const price = Number(exitPrice);
    if (!price || price <= 0) {
      setError(t("routes.trades.validExitPrice"));
      return;
    }
    closeTrade.mutate({ id: trade.id, exitPrice: price, trade });
    onClose();
  };

  return (
    <div className="mt-2 flex items-center gap-2 flex-wrap">
      <input
        className="border-input bg-background rounded-md border px-2 py-1.5 text-sm w-32"
        placeholder={t("routes.trades.exitPricePlaceholder")}
        type="number"
        min="0"
        value={exitPrice}
        onChange={(e) => setExitPrice(e.target.value)}
      />
      {previewPnl !== null && (
        <span className={cn("text-xs font-semibold", pnlTone(previewPnl))}>
          {formatPnl(previewPnl)}
        </span>
      )}
      <Button size="sm" onClick={handleClose} disabled={closeTrade.isPending}>
        <Check className="h-3 w-3 mr-1" />
        {t("routes.trades.close")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose}>
        {t("routes.trades.cancel")}
      </Button>
      {error && <p className="text-destructive text-xs w-full">{error}</p>}
    </div>
  );
}

// ── Open Position Card (hero — live PnL) ──────────────────────────────────────

function OpenPositionCard({ row }: { row: OpenTradePnl }) {
  const { t } = useTranslation();
  const { trade, livePrice, unrealizedPnl, unrealizedPct } = row;
  const deleteTrade = useDeleteTrade();
  const [showClose, setShowClose] = useState(false);
  const isLive = livePrice !== null;
  const markPrice = livePrice ?? trade.entry_price;

  return (
    <IqCard
      className={cn(
        "space-y-2.5 p-3 border-l-2",
        unrealizedPnl === null
          ? "border-l-transparent"
          : unrealizedPnl >= 0
            ? "border-l-bullish"
            : "border-l-bearish",
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <AssetIcon ticker={trade.symbol} className="h-8 w-8 text-sm" />

        <div className="min-w-[110px] flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold">{trade.symbol}</span>
            {trade.direction === "long" ? (
              <TrendingUp className="h-3.5 w-3.5 text-bullish" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-bearish" />
            )}
            {trade.leverage > 1 && (
              <span className="text-[10px] font-semibold text-warning px-1 rounded border border-warning/30 bg-warning-soft">
                {trade.leverage}×
              </span>
            )}
            {trade.strategy && (
              <span className="text-xs text-muted-foreground">· {trade.strategy}</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <LiveDot live={isLive} />
            {isLive ? t("routes.trades.live") : t("routes.trades.awaitingTick")}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className={cn("num text-lg font-bold leading-tight", pnlTone(unrealizedPnl))}>
            {formatPnl(unrealizedPnl)}
          </div>
          <div className={cn("num text-xs font-semibold", pnlTone(unrealizedPnl))}>
            {formatPct(unrealizedPct)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
        <Metric label={t("routes.trades.entry")} value={formatMoney(trade.entry_price)} />
        <Metric
          label={isLive ? t("routes.trades.mark") : t("routes.trades.markEntry")}
          value={formatMoney(markPrice)}
        />
        <Metric label={t("routes.trades.quantity")} value={String(trade.quantity)} />
      </div>

      {trade.notes && (
        <p className="text-xs text-muted-foreground italic border-t border-border/50 pt-2">
          {trade.notes}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-border/40 pt-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowClose((v) => !v)}
          className="text-xs h-7 px-2"
        >
          <DollarSign className="h-3 w-3 mr-1" />
          {t("routes.trades.closeTrade")}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 ml-auto text-muted-foreground hover:text-bearish"
          onClick={() => deleteTrade.mutate(trade.id)}
          disabled={deleteTrade.isPending}
          aria-label={t("routes.trades.deleteTradeAria", { symbol: trade.symbol })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {showClose && <CloseTradeInline trade={trade} onClose={() => setShowClose(false)} />}
    </IqCard>
  );
}

// ── Trade Row (history) ───────────────────────────────────────────────────────

function TradeRow({ trade }: { trade: Trade }) {
  const { t } = useTranslation();
  const deleteTrade = useDeleteTrade();

  return (
    <IqCard className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <AssetIcon ticker={trade.symbol} className="h-8 w-8 text-sm" />

        <div className="min-w-[110px] flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold">{trade.symbol}</span>
            {trade.direction === "long" ? (
              <TrendingUp className="h-3.5 w-3.5 text-bullish" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-bearish" />
            )}
            {trade.leverage > 1 && (
              <span className="text-[10px] font-semibold text-warning px-1 rounded border border-warning/30 bg-warning-soft">
                {trade.leverage}×
              </span>
            )}
            {trade.strategy && (
              <span className="text-xs text-muted-foreground">· {trade.strategy}</span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t("routes.trades.opened", {
              date: trade.opened_at
                ? new Date(trade.opened_at).toLocaleDateString()
                : t("routes.trades.recently"),
            })}
          </div>
        </div>

        <Badge variant="outline" className={cn("shrink-0", STATUS_TONE[trade.status])}>
          {t(`routes.trades.${STATUS_LABEL_KEY[trade.status]}`)}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Metric label={t("routes.trades.entry")} value={formatMoney(trade.entry_price)} />
        <Metric label={t("routes.trades.quantity")} value={String(trade.quantity)} />
        {trade.exit_price ? (
          <Metric label={t("routes.trades.exit")} value={formatMoney(trade.exit_price)} />
        ) : (
          <Metric label={t("routes.trades.exit")} value={t("routes.trades.open")} />
        )}
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("routes.trades.pnl")}
          </div>
          <div className={cn("num font-semibold", pnlTone(trade.pnl))}>
            {formatPnl(trade.pnl)}
            {trade.pnl_percent !== null && (
              <span className="ml-1 text-[10px]">
                ({trade.pnl_percent >= 0 ? "+" : ""}
                {trade.pnl_percent?.toFixed(1)}%)
              </span>
            )}
          </div>
        </div>
      </div>

      {trade.notes && (
        <p className="text-xs text-muted-foreground italic border-t border-border/50 pt-2">
          {trade.notes}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-border/40 pt-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 ml-auto text-muted-foreground hover:text-bearish"
          onClick={() => deleteTrade.mutate(trade.id)}
          disabled={deleteTrade.isPending}
          aria-label={t("routes.trades.deleteTradeAria", { symbol: trade.symbol })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
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

// ── Aggregate Open PnL (the glance) ───────────────────────────────────────────

function AggregateOpenPnl({
  totalUnrealized,
  count,
  livePriced,
  isLoading,
}: {
  totalUnrealized: number;
  count: number;
  livePriced: number;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const hasPositions = count > 0;
  const tone = !hasPositions ? "neutral" : totalUnrealized >= 0 ? "bullish" : "bearish";

  return (
    <IqCard
      className={cn(
        "space-y-1.5",
        tone === "bullish" && "border-bullish/30 bg-bullish-soft",
        tone === "bearish" && "border-bearish/30 bg-bearish-soft",
      )}
    >
      <div className="flex items-center justify-between">
        <CardEyebrow>{t("routes.trades.openPnl")}</CardEyebrow>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <LiveDot live={hasPositions && livePriced > 0} />
          {hasPositions
            ? t("routes.trades.livePriced", { live: livePriced, count })
            : t("routes.trades.noPositions")}
        </div>
      </div>
      {isLoading ? (
        <span className="block h-9 w-40 animate-pulse rounded bg-muted" />
      ) : (
        <div
          className={cn(
            "num text-3xl font-bold tracking-tight sm:text-4xl",
            pnlTone(hasPositions ? totalUnrealized : null),
          )}
        >
          {hasPositions ? formatPnl(totalUnrealized) : "—"}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {hasPositions ? t("routes.trades.acrossPositions", { count }) : t("routes.trades.noRunningPositions")}
      </p>
    </IqCard>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function TradesPage() {
  const { t } = useTranslation();
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [showNewForm, setShowNewForm] = useState(false);

  const openPnl = useOpenTradesPnl();

  const historyStatusFilter = historyFilter === "all" ? undefined : historyFilter;
  const { trades: historyRaw, isLoading: historyLoading } = useTrades(historyStatusFilter);
  const historyTrades = historyRaw.filter((t) => t.status !== "open");

  const allTrades = useTrades(); // for journal summary stats
  const summary = summarizeTrades(allTrades.trades);
  const authenticated = openPnl.authenticated;

  return (
    <div className="space-y-5 pb-20 lg:pb-6">
      <PageHeader
        eyebrow={t("routes.trades.eyebrow")}
        title={t("routes.trades.title")}
        subtitle={t("routes.trades.subtitle")}
      />

      {/* Auth prompt */}
      {!authenticated && (
        <IqCard className="space-y-2 text-center text-sm text-muted-foreground">
          <p>{t("routes.trades.signInPrompt1")}</p>
          <p>
            <Link to="/login" className="font-medium text-info underline-offset-2 hover:underline">
              {t("common.signIn")}
            </Link>{" "}
            {t("routes.trades.signInPrompt2")}
          </p>
        </IqCard>
      )}

      {authenticated && (
        <>
          {/* ── HERO: running positions ──────────────────────────────────── */}
          <AggregateOpenPnl
            totalUnrealized={openPnl.totalUnrealized}
            count={openPnl.count}
            livePriced={openPnl.livePriced}
            isLoading={openPnl.isLoading}
          />

          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t("routes.trades.runningPositions")}
            </h2>
            {openPnl.count > 0 && (
              <Badge variant="outline" className="border-info/30 bg-info-soft text-info">
                {openPnl.count}
              </Badge>
            )}
            <Button
              size="sm"
              className="ml-auto h-8 gap-1.5 text-xs"
              onClick={() => setShowNewForm((v) => !v)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("routes.trades.newTradeButton")}
            </Button>
          </div>

          {showNewForm && <NewTradeForm onClose={() => setShowNewForm(false)} />}

          {openPnl.isLoading ? (
            <IqCard className="text-center text-sm text-muted-foreground py-6">
              {t("routes.trades.loadingPositions")}
            </IqCard>
          ) : openPnl.rows.length === 0 ? (
            <IqCard className="text-center text-sm text-muted-foreground py-6">
              {t("routes.trades.noRunningClickNewTrade")}
            </IqCard>
          ) : (
            <div className="space-y-2.5">
              {openPnl.rows.map((row) => (
                <OpenPositionCard key={row.trade.id} row={row} />
              ))}
            </div>
          )}

          {/* ── HISTORY: journal ──────────────────────────────────────────── */}
          <div className="pt-2">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t("routes.trades.journal")}
            </h2>

            <IqCard className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label={t("routes.trades.statTotalTrades")} value={String(summary.total)} />
              <StatTile label={t("routes.trades.statClosed")} value={String(summary.closed)} />
              <StatTile
                label={t("routes.trades.statWinRate")}
                value={
                  summary.closed ? (summary.winRate !== null ? `${summary.winRate}%` : "—") : "—"
                }
                tone={
                  summary.winRate !== null
                    ? summary.winRate >= 50
                      ? "bullish"
                      : "bearish"
                    : undefined
                }
              />
              <StatTile
                label={t("routes.trades.statTotalRealizedPnl")}
                value={summary.totalPnl !== null ? formatPnl(summary.totalPnl) : "—"}
                tone={
                  summary.totalPnl !== null
                    ? summary.totalPnl >= 0
                      ? "bullish"
                      : "bearish"
                    : undefined
                }
              />
            </IqCard>

            <div className="mb-3 flex items-center gap-1.5">
              {HISTORY_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setHistoryFilter(f.value)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                    historyFilter === f.value
                      ? "border-info/30 bg-info-soft text-info"
                      : "border-border bg-surface text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`routes.trades.${f.labelKey}`)}
                </button>
              ))}
            </div>

            {historyLoading ? (
              <IqCard className="text-center text-sm text-muted-foreground py-6">
                {t("routes.trades.loadingJournal")}
              </IqCard>
            ) : historyTrades.length === 0 ? (
              <IqCard className="text-center text-sm text-muted-foreground py-6">
                {historyFilter === "all"
                  ? t("routes.trades.noClosedTradesYet")
                  : t(`routes.trades.${historyFilter === "closed" ? "noClosedFilterTrades" : "noCancelledFilterTrades"}`,
                    )}
              </IqCard>
            ) : (
              <div className="space-y-2.5">
                {historyTrades.map((trade) => (
                  <TradeRow key={trade.id} trade={trade} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 text-sm font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value}
      </div>
    </div>
  );
}
