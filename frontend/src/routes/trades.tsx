import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Plus, Trash2, TrendingDown, TrendingUp, X, Check, DollarSign } from "lucide-react";

import { AssetIcon } from "@/components/features/asset-icon";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { PageHeader } from "@/components/features/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useTrades,
  useCreateTrade,
  useUpdateTrade,
  useDeleteTrade,
  useCloseTrade,
  type Trade,
  type TradeCreate,
} from "@/hooks/useTrades";
import { formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/trades")({
  head: () => ({
    meta: [
      { title: "Trade Journal — Market Pulse" },
      {
        name: "description",
        content: "Track and journal your crypto trades with PnL tracking and analytics.",
      },
      { property: "og:title", content: "Trade Journal — Market Pulse" },
      {
        property: "og:description",
        content: "Your personal trade journal: log entries, exits, and performance.",
      },
    ],
  }),
  component: TradesPage,
});

type Filter = "all" | "open" | "closed" | "cancelled";
const FILTERS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
];

const STATUS_TONE: Record<Trade["status"], string> = {
  open: "border-info/30 bg-info-soft text-info",
  closed: "border-muted/30 bg-surface text-muted-foreground",
  cancelled: "border-muted/30 bg-surface text-muted-foreground",
};

function formatPnl(pnl: number | null): string {
  if (pnl === null) return "—";
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}${formatMoney(pnl)}`;
}

function pnlTone(pnl: number | null): string {
  if (pnl === null) return "text-muted-foreground";
  return pnl >= 0 ? "text-bullish" : "text-bearish";
}

// ── Summary Statistics ────────────────────────────────────────────────────────

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
      setError("Symbol is required.");
      return;
    }
    if (!entryPrice || entryPrice <= 0) {
      setError("Entry price must be positive.");
      return;
    }
    if (!quantity || quantity <= 0) {
      setError("Quantity must be positive.");
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
        <CardEyebrow>New Trade</CardEyebrow>
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
            Symbol
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
            Direction
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
                {d === "long" ? "Long ↑" : "Short ↓"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Entry Price
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
            Quantity
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
            Leverage
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
            Strategy (optional)
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
          Notes (optional)
        </label>
        <textarea
          className="border-input bg-background rounded-md border px-3 py-2 text-sm resize-none"
          placeholder="Why did you take this trade?"
          rows={2}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex gap-2 pt-1">
        <Button className="flex-1" onClick={handleSubmit} disabled={createTrade.isPending}>
          {createTrade.isPending ? "Logging…" : "Log Trade"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </IqCard>
  );
}

// ── Close Trade Form ──────────────────────────────────────────────────────────

function CloseTradeInline({ trade, onClose }: { trade: Trade; onClose: () => void }) {
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
      setError("Enter a valid exit price.");
      return;
    }
    closeTrade.mutate({ id: trade.id, exitPrice: price, trade });
    onClose();
  };

  return (
    <div className="mt-2 flex items-center gap-2 flex-wrap">
      <input
        className="border-input bg-background rounded-md border px-2 py-1.5 text-sm w-32"
        placeholder="Exit price"
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
        Close
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {error && <p className="text-destructive text-xs w-full">{error}</p>}
    </div>
  );
}

// ── Trade Row ─────────────────────────────────────────────────────────────────

function TradeRow({ trade }: { trade: Trade }) {
  const deleteTrade = useDeleteTrade();
  const [showClose, setShowClose] = useState(false);
  const isOpen = trade.status === "open";

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
            Opened {trade.opened_at ? new Date(trade.opened_at).toLocaleDateString() : "recently"}
          </div>
        </div>

        <Badge variant="outline" className={cn("shrink-0", STATUS_TONE[trade.status])}>
          {trade.status.charAt(0).toUpperCase() + trade.status.slice(1)}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Metric label="Entry" value={formatMoney(trade.entry_price)} />
        <Metric label="Quantity" value={String(trade.quantity)} />
        {trade.exit_price ? (
          <Metric label="Exit" value={formatMoney(trade.exit_price)} />
        ) : (
          <Metric label="Exit" value="Open" />
        )}
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            PnL
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
        {isOpen && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowClose((v) => !v)}
            className="text-xs h-7 px-2"
          >
            <DollarSign className="h-3 w-3 mr-1" />
            Close Trade
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 ml-auto text-muted-foreground hover:text-bearish"
          onClick={() => deleteTrade.mutate(trade.id)}
          disabled={deleteTrade.isPending}
          aria-label={`Delete ${trade.symbol} trade`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {showClose && isOpen && (
        <CloseTradeInline trade={trade} onClose={() => setShowClose(false)} />
      )}
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

// ── Page ──────────────────────────────────────────────────────────────────────

function TradesPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [showNewForm, setShowNewForm] = useState(false);

  const statusFilter = filter === "all" ? undefined : filter;
  const { trades, authenticated, isLoading } = useTrades(statusFilter);

  const allTrades = useTrades(); // for summary stats
  const summary = summarizeTrades(allTrades.trades);

  return (
    <div className="space-y-5 pb-20 lg:pb-6">
      <PageHeader
        eyebrow="Trade Journal"
        title="Trades"
        subtitle="Log your trades and track performance over time. Entries are stored on the server and persist across devices."
      />

      {/* Summary stats */}
      <IqCard className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Total trades" value={String(summary.total)} />
        <StatTile label="Open" value={String(summary.open)} />
        <StatTile
          label="Win rate"
          value={summary.closed ? (summary.winRate !== null ? `${summary.winRate}%` : "—") : "—"}
          tone={
            summary.winRate !== null ? (summary.winRate >= 50 ? "bullish" : "bearish") : undefined
          }
        />
        <StatTile
          label="Total PnL"
          value={summary.totalPnl !== null ? formatPnl(summary.totalPnl) : "—"}
          tone={
            summary.totalPnl !== null ? (summary.totalPnl >= 0 ? "bullish" : "bearish") : undefined
          }
        />
      </IqCard>

      {/* Filters + Add button */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f.value
                  ? "border-info/30 bg-info-soft text-info"
                  : "border-border bg-surface text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          className="ml-auto h-8 gap-1.5 text-xs"
          onClick={() => setShowNewForm(true)}
          disabled={!authenticated}
        >
          <Plus className="h-3.5 w-3.5" />
          New Trade
        </Button>
      </div>

      {/* New trade form */}
      {showNewForm && authenticated && <NewTradeForm onClose={() => setShowNewForm(false)} />}

      {/* Auth prompt */}
      {!authenticated && (
        <IqCard className="space-y-2 text-center text-sm text-muted-foreground">
          <p>Your trade journal lives on the server — sign in to start logging trades.</p>
          <p>
            <Link to="/login" className="font-medium text-info underline-offset-2 hover:underline">
              Sign in
            </Link>{" "}
            to access your trade journal.
          </p>
        </IqCard>
      )}

      {/* Trades list */}
      {authenticated && (
        <>
          {isLoading ? (
            <IqCard className="text-center text-sm text-muted-foreground py-6">
              Loading trades…
            </IqCard>
          ) : trades.length === 0 ? (
            <IqCard className="text-center text-sm text-muted-foreground py-6">
              {filter === "all"
                ? 'No trades logged yet — click "New Trade" to start your journal.'
                : `No ${filter} trades.`}
            </IqCard>
          ) : (
            <div className="space-y-2.5">
              {trades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} />
              ))}
            </div>
          )}
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
