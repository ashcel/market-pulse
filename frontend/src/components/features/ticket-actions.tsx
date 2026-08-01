import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { createDecision, setDecisionAction } from "@/hooks/useDecisions";
import type { TradingIntent } from "@/lib/engine/intent";

const REASONS = [
  ["invalid", "Setup tidak valid"],
  ["late", "Sudah terlambat"],
  ["no_conviction", "Belum yakin"],
  ["risk", "Risiko terlalu besar"],
] as const;

export function TicketActions({
  symbol,
  objective,
  direction,
  entry,
  stop,
  target,
  onEntry,
}: {
  symbol: string;
  objective: TradingIntent;
  direction: "long" | "short" | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  onEntry: () => void;
}) {
  const [skipOpen, setSkipOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const captureSkip = async (skipReason: (typeof REASONS)[number][0]) => {
    if (!direction || saving) return;
    setSaving(true);
    try {
      const decision = await createDecision({
        symbol,
        objective,
        direction,
        verdict_at_time: "ticket_skip",
        catalyst_modifier: null,
        skip_check_result: null,
        entry_zone: entry == null ? null : { entry },
        stop_loss: stop,
        take_profit: target,
        engine_version: import.meta.env.VITE_ENGINE_VERSION ?? "current",
      });
      await setDecisionAction(decision.id, "rejected_skip", undefined, skipReason);
      setSkipOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onEntry} disabled={!direction}>Entry</Button>
        <Button size="sm" variant="outline" onClick={() => setSkipOpen(true)} disabled={!direction}>Lewati</Button>
      </div>
      <Sheet open={skipOpen} onOpenChange={setSkipOpen}>
        <SheetContent side="bottom" className="mx-auto max-w-md rounded-t-xl">
          <SheetHeader>
            <SheetTitle>Kenapa lewati {symbol}?</SheetTitle>
          </SheetHeader>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {REASONS.map(([value, label]) => (
              <Button key={value} variant="outline" className="h-auto min-h-14 whitespace-normal" disabled={saving} onClick={() => void captureSkip(value)}>
                {label}
              </Button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
