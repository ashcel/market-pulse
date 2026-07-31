import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { apiV1Json } from "../miniapp/api";
import { QuantTokenChart } from "./quant-token-chart";
import type { QuantSignal, QuantState } from "./types";

/**
 * The quant-notifier feed, read-only: regime strip on top, then the signal
 * cards the scan produced. Tapping a card opens that token's chart inline.
 *
 * Nothing here is re-derived locally — the numbers are whatever the dashboard
 * computed, so the Mini App and the bot's own page can never disagree.
 */

const REGIME_EMOJI: Record<string, string> = {
  bull: "🟢",
  bear: "🔴",
  sideways: "🟡",
  neutral: "🟡",
};

const CONVICTION_TONE: Record<string, string> = {
  high: "border-bullish/30 bg-bullish-soft text-bullish",
  "high-conviction": "border-bullish/30 bg-bullish-soft text-bullish",
  medium: "border-info/30 bg-info/10 text-info",
  low: "border-border bg-surface text-muted-foreground",
};

function regimeChip(label: string, regime: string | null | undefined, extra?: string) {
  const key = (regime ?? "").toLowerCase();
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface px-2.5 py-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xs font-semibold">
        {REGIME_EMOJI[key] ?? "⚪"} {regime ?? "—"}
      </span>
      {extra && <span className="text-[10px] text-muted-foreground">{extra}</span>}
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}j`;
  return `${Math.floor(hours / 24)}h`;
}

function SignalCard({ signal, onOpen }: { signal: QuantSignal; onOpen: () => void }) {
  const tier = signal.conviction ?? "low";
  const demoted = signal.baseConviction && signal.baseConviction !== signal.conviction;
  const dir = signal.direction === "short" ? "🔻" : signal.direction === "long" ? "🔺" : "•";
  return (
    <button
      onClick={onOpen}
      className={cn(
        "w-full rounded-lg border border-border bg-surface p-3 text-left transition-colors active:bg-surface/70",
        !signal.notified && "opacity-70",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight">
            {dir} {signal.symbol}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">{signal.kind}</span>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            CONVICTION_TONE[tier] ?? CONVICTION_TONE.low,
          )}
        >
          {tier.replace("-", " ")}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {timeAgo(signal.at)} lalu · {signal.notified ? "dikirim" : "senyap"}
        {signal.rank ? ` · rank #${signal.rank}` : ""}
        {signal.provisional ? " · provisional" : ""}
      </div>
      {demoted && (
        <div className="mt-1 text-[11px] text-warning">
          {signal.baseConviction} → {signal.conviction} karena regime {signal.regime ?? "?"}
        </div>
      )}
    </button>
  );
}

export function QuantFeed() {
  const [openSymbol, setOpenSymbol] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["quant-state", 14],
    queryFn: () => apiV1Json<QuantState>("/api/v1/quant/state?days=14"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-surface" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        Data quant tidak bisa dimuat.
        <div className="mt-1 text-[11px]">{(query.error as Error).message}</div>
      </div>
    );
  }

  const state = query.data!;
  const structure = state.regimes?.structure;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {regimeChip(
          "Crypto",
          state.regimes?.crypto?.regime,
          state.regimes?.crypto?.changePercent != null
            ? `7d ${state.regimes.crypto.changePercent}%`
            : undefined,
        )}
        {regimeChip(
          "Saham",
          state.regimes?.stock?.regime,
          state.regimes?.stock?.changePercent != null
            ? `7d ${state.regimes.stock.changePercent}%`
            : undefined,
        )}
      </div>

      {structure && (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-muted-foreground">
          Struktur 1D <span className="text-foreground">{structure.daily ?? "—"}</span> · 4H{" "}
          <span className="text-foreground">{structure.fourHour ?? "—"}</span>
          {structure.conflict && <span className="text-warning"> · konflik</span>}
        </div>
      )}

      <div className="text-[11px] text-muted-foreground">
        {state.summary.total} sinyal / {state.summary.days} hari · {state.summary.notified} dikirim
      </div>

      {openSymbol && (
        <div className="rounded-lg border border-border bg-surface p-3">
          <QuantTokenChart symbol={openSymbol} onBack={() => setOpenSymbol(null)} />
        </div>
      )}

      {state.signals.length === 0 ? (
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          Belum ada sinyal.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {state.signals.map((s, i) => (
            <SignalCard
              key={`${s.symbol}-${s.at}-${i}`}
              signal={s}
              onOpen={() => setOpenSymbol(s.symbol)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
