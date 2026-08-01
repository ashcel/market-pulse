import { createFileRoute } from "@tanstack/react-router";

import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { Badge } from "@/components/ui/badge";
import { useConstitution } from "@/hooks/useConstitution";
import { type MarketPosition, useMpPositions, useTradewayPositions } from "@/hooks/useBook";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/book")({ component: BookPage });

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positionNotional(position: MarketPosition): number {
  const value = number(position.positionValue);
  if (value !== null) return Math.abs(value);
  const amount = number(position.positionAmt ?? position.size);
  const mark = number(position.markPrice);
  return amount !== null && mark !== null ? Math.abs(amount * mark) : 0;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function PositionCard({ position, source }: { position: MarketPosition; source: "MP" | "Tradeway" }) {
  const isShort = position.side.toUpperCase().startsWith("S") || (number(position.positionAmt) ?? 0) < 0;
  const pnl = number(position.unrealizedPnl ?? position.unrealisedPnl);
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{position.symbol}</span>
          <Badge variant="outline" className="text-[10px]">{source}</Badge>
          <Badge className={cn("text-[10px]", isShort ? "bg-bearish-soft text-bearish" : "bg-bullish-soft text-bullish")}>
            {isShort ? "SHORT" : "LONG"}
          </Badge>
        </div>
        <span className={cn("num text-sm font-semibold", pnl === null ? "text-muted-foreground" : pnl >= 0 ? "text-bullish" : "text-bearish")}>
          {pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}`}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
        <div><div>Nilai</div><div className="num text-foreground">{formatUsd(positionNotional(position))}</div></div>
        <div><div>Entry</div><div className="num text-foreground">{position.entryPrice ?? "—"}</div></div>
        <div><div>Mark</div><div className="num text-foreground">{position.markPrice ?? "—"}</div></div>
      </div>
    </div>
  );
}

function BookPage() {
  const mp = useMpPositions();
  const tradeway = useTradewayPositions();
  const { constitution, executionEnabled, isLoading: constitutionLoading } = useConstitution();
  const tw = tradeway.data;
  const mpExposure = mp.positions.reduce((total, position) => total + positionNotional(position), 0);
  const twExposure = tw?.positions.reduce((total, position) => total + positionNotional(position), 0) ?? 0;
  const riskBudget = constitution ? constitution.risk_per_trade_percent : null;
  const remainingSlots = constitution ? Math.max(0, constitution.max_concurrent_positions - mp.positions.length) : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <CardEyebrow>Book</CardEyebrow>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Posisi & risiko</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sumber posisi dipisahkan agar kepemilikan fakta tetap jelas.</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <IqCard><CardEyebrow>Eksposur total</CardEyebrow><div className="num mt-2 text-xl font-bold">{formatUsd(mpExposure + twExposure)}</div><p className="mt-1 text-xs text-muted-foreground">MP {formatUsd(mpExposure)} · Tradeway {formatUsd(twExposure)}</p></IqCard>
        <IqCard><CardEyebrow>Sisa risk budget</CardEyebrow><div className="num mt-2 text-xl font-bold">{remainingSlots === null ? "—" : `${remainingSlots} slot`}</div><p className="mt-1 text-xs text-muted-foreground">Maks. {riskBudget?.toFixed(1) ?? "—"}% risiko per trade menurut Constitution.</p></IqCard>
        <IqCard><CardEyebrow>Kill-switch</CardEyebrow><div className="mt-2 text-xl font-bold">{constitutionLoading ? "Memuat" : executionEnabled ? "Aktif" : "Nonaktif"}</div><p className="mt-1 text-xs text-muted-foreground">State eksekusi dari Constitution.</p></IqCard>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between"><h2 className="font-semibold">Posisi MP</h2><Badge variant="outline">{mp.state === "live" ? "Live SSE" : mp.state === "error" ? "Stream terputus" : "Menghubungkan"}</Badge></div>
        {mp.positions.length === 0 ? <IqCard><p className="text-sm text-muted-foreground">Belum ada posisi MP terbuka.</p></IqCard> : mp.positions.map((position, index) => <PositionCard key={`${position.symbol}-${position.side}-${index}`} position={position} source="MP" />)}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between"><h2 className="font-semibold">Posisi Tradeway</h2><Badge variant="outline">Tradeway</Badge></div>
        {tradeway.isLoading ? <IqCard><p className="text-sm text-muted-foreground">Memuat posisi Tradeway…</p></IqCard> : tw?.offline ? <IqCard><p className="font-medium">Tradeway sedang offline</p><p className="mt-1 text-xs text-muted-foreground">Posisi dari layanan 8100 tidak tersedia; data MP di atas tidak dipakai sebagai pengganti.</p></IqCard> : tw?.positions.length === 0 ? <IqCard><p className="text-sm text-muted-foreground">Tidak ada posisi Tradeway terbuka.</p></IqCard> : tw?.positions.map((position, index) => <PositionCard key={`${position.symbol}-${position.side}-${index}`} position={position} source="Tradeway" />)}
      </section>
    </main>
  );
}
