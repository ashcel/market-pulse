import { History } from "lucide-react";

import { summarizeAnticipatoryRecord } from "@/lib/engine/anticipatory";
import { useAnticipatorySignalsStore } from "@/stores/anticipatory-signals";

/**
 * Compact status line for the Phase 0.5 anticipatory fill-model record —
 * global across symbols, measurement only, read by no verdict (EDR 0010).
 * Hidden until at least one record has decided its fill, so the Evidence tab
 * doesn't advertise an empty ledger.
 */
export function AnticipatoryRecordNote() {
  const signals = useAnticipatorySignalsStore((s) => s.signals);
  const summary = summarizeAnticipatoryRecord(signals);
  if (summary.filled + summary.neverFilled === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-surface p-2.5 text-[11px] leading-relaxed text-muted-foreground">
      <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          Anticipatory limit record (all symbols)
        </span>
        <p className="mt-0.5">
          {summary.fillRate}% of resting limits filled ({summary.filled} of{" "}
          {summary.filled + summary.neverFilled} decided
          {summary.pending > 0 ? `, ${summary.pending} still resting` : ""}).
          {summary.settled > 0
            ? ` Filled positions: ${summary.winRate}% wins, ${summary.averageR >= 0 ? "+" : ""}${summary.averageR}R avg over ${summary.settled} settled${summary.lowSample ? " — small sample, treat as anecdote" : ""}.`
            : " No filled position has settled yet."}
        </p>
      </div>
    </div>
  );
}
