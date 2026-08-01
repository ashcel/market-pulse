import { Badge } from "@/components/ui/badge";
import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { useRelatedSignals } from "@/hooks/useIdeas";

export function RelatedSignalsCard({ symbol }: { symbol: string }) {
  const query = useRelatedSignals(symbol);
  const signals = query.data ?? [];

  return (
    <IqCard className="mx-3 shrink-0 sm:mx-4">
      <CardEyebrow>Sinyal terkait</CardEyebrow>
      {query.isLoading && <p className="mt-2 text-xs text-muted-foreground">Memuat sinyal…</p>}
      {!query.isLoading && signals.length === 0 && <p className="mt-2 text-xs text-muted-foreground">Belum ada sinyal tercatat untuk {symbol}.</p>}
      {signals.length > 0 && <div className="mt-2 flex flex-col gap-2">{signals.slice(0, 3).map((signal) => (
        <div key={signal.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">{signal.source === "quant" ? "Quant" : signal.source} · {signal.kind.replace("-alignment", "-align")}</span>
          <Badge variant="outline" className={signal.side === "long" ? "text-bullish" : "text-bearish"}>{signal.side === "long" ? "naik" : "turun"}</Badge>
        </div>
      ))}</div>}
    </IqCard>
  );
}
