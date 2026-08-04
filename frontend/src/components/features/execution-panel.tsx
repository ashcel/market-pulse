import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, ShieldCheck } from "lucide-react";
import { TradeTicket } from "./trade-ticket";
import { PermitCard } from "./permit-card";
import { useTradeTicket } from "@/hooks/useTradeTicket";
import { usePermit } from "@/hooks/usePermit";
import { useCreateTrade } from "@/hooks/useTrades";
import { useConstitution } from "@/hooks/useConstitution";
import { IqCard } from "@/components/features/iq-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PermitCardApproved } from "@/lib/types/execution";
import type { TradeTicketState } from "@/hooks/useTradeTicket";
import type { SizingPreview } from "@/hooks/useSkipCheck";
import { setDecisionAction } from "@/hooks/useDecisions";

/**
 * Plan-derived numbers used to mirror a confirmed trade into the journal
 * the instant it's placed. Presentation/wiring only.
 */
export interface ExecutionLogContext {
  symbol: string;
  direction: "long" | "short";
  entry_price: number;
  quantity: number;
  leverage?: number;
  strategy?: string;
}

const DEPTH_PREF_KEY = "iq-ticket-depth-open";

/** What the user confirmed they are taking. IQ does not transmit the order
 * (EDR 0024 decision 4) — this records that an approved permit was acted on,
 * and mirrors the plan into the journal. */
export interface TakenPlan {
  permit_id: string;
  symbol: string;
  side: string;
  entry_price: number;
  stop_price: number;
  target_price: number;
}

export function ExecutionPanel({
  initialTicket,
  className,
  logContext,
  serverSizing,
  decisionId,
}: {
  initialTicket?: Partial<TradeTicketState>;
  className?: string;
  logContext?: ExecutionLogContext;
  /** Server-derived sizing (qty/notional/margin) from a Skip Check, when the
   * ticket is opened as a Check continuation. */
  serverSizing?: SizingPreview | null;
  decisionId?: string | null;
}) {
  const ticket = useTradeTicket(initialTicket);
  const permitReq = usePermit();
  const createTrade = useCreateTrade();
  const { constitution } = useConstitution();

  const [isConfirming, setIsConfirming] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [takenPlan, setTakenPlan] = useState<TakenPlan | null>(null);
  const [depthOpen, setDepthOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(DEPTH_PREF_KEY) === "1";
  });

  const maxLeverage = constitution?.max_leverage ?? 5;
  const maxRiskPercent = constitution?.risk_per_trade_percent ?? 3;

  const setDepth = (open: boolean) => {
    setDepthOpen(open);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DEPTH_PREF_KEY, open ? "1" : "0");
    }
  };

  // Reset when a new context is deep-linked in.
  useEffect(() => {
    if (!initialTicket) return;
    ticket.replace(initialTicket);
    permitReq.clearPermit();
    setTakenPlan(null);
    setExecutionError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialTicket)]);

  // Zone 3: the permit is auto-requested (debounced ~500ms) on valid input —
  // no "get permit" button. Same permit path at both depths.
  const validKey = ticket.isValid
    ? JSON.stringify({
        s: ticket.state.symbol,
        side: ticket.state.side,
        e: ticket.state.entry_price,
        st: ticket.state.stop_price,
        t: ticket.state.target_price,
        r: ticket.state.risk_percent,
        l: ticket.state.leverage,
        m: ticket.state.margin_type,
      })
    : null;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!validKey || takenPlan) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void permitReq.requestPermit(ticket.state);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validKey]);

  // "I'm taking this" — the permit is the product's output, and the user
  // places the order on the exchange themselves (EDR 0024 decision 4). This
  // records the decision and mirrors the plan into the journal so the review
  // plane can measure what was actually done against what was approved.
  const handleConfirm = async () => {
    setIsConfirming(true);
    setExecutionError(null);
    try {
      const approvedPermit = permitReq.permit as PermitCardApproved;
      const permitId = approvedPermit?.permit_id;
      if (!permitId) {
        setExecutionError("Permit not ready. Adjust the ticket to re-request.");
        setIsConfirming(false);
        return;
      }

      if (decisionId) {
        await setDecisionAction(decisionId, "took_trade", { permit_id: permitId });
      }

      if (logContext) {
        await createTrade.mutateAsync(logContext);
      }

      setTakenPlan({
        permit_id: permitId,
        symbol: ticket.state.symbol,
        side: ticket.state.side,
        entry_price: Number(ticket.state.entry_price),
        stop_price: Number(ticket.state.stop_price),
        target_price: Number(ticket.state.target_price),
      });
    } catch (err) {
      setExecutionError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsConfirming(false);
    }
  };

  const handleReset = () => {
    ticket.reset();
    permitReq.clearPermit();
    setTakenPlan(null);
    setExecutionError(null);
  };

  // Taken state — the plan is logged; the order is the user's to place.
  if (takenPlan) {
    return (
      <div className={className ?? "mx-auto w-full max-w-md"}>
        <IqCard className="flex flex-col items-center gap-4 py-10 text-center">
          <ShieldCheck className="h-12 w-12 text-bullish" />
          <h3 className="text-lg font-bold">Plan logged</h3>
          <p className="max-w-xs text-xs text-muted-foreground">
            Place it on the exchange yourself — {takenPlan.side} {takenPlan.symbol}, entry{" "}
            {takenPlan.entry_price}, stop {takenPlan.stop_price}, target {takenPlan.target_price}.
            IQ judged this trade and recorded it; it does not send orders.
          </p>
          <p className="text-xs text-muted-foreground">
            Your stop is the permit&apos;s condition — a filled entry with no stop is the one thing
            this plan cannot survive.
          </p>
          <div className="mt-2 flex items-center gap-2">
            {logContext && (
              <Button asChild size="sm">
                <Link to="/trades">View running trades</Link>
              </Button>
            )}
            <Button onClick={handleReset} variant="outline" size="sm">
              New Trade
            </Button>
          </div>
        </IqCard>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className ?? "mx-auto w-full max-w-md")}>
      {permitReq.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {permitReq.error}
        </div>
      )}

      <TradeTicket
        state={ticket.state}
        setField={ticket.setField}
        isValid={ticket.isValid}
        estimatedRR={ticket.estimatedRR}
        maxLeverage={maxLeverage}
        maxRiskPercent={maxRiskPercent}
        serverSizing={serverSizing}
        depthOpen={depthOpen}
        onDepthChange={setDepth}
      />

      {/* Zone 3 — permit auto-requested inline (no button). */}
      {ticket.isValid && (
        <div className="flex flex-col gap-3">
          {executionError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {executionError}
            </div>
          )}
          {permitReq.loading && !permitReq.permit && (
            <IqCard className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Requesting permit…
            </IqCard>
          )}
          {permitReq.permit && (
            <PermitCard
              permit={permitReq.permit}
              timeRemainingSeconds={permitReq.timeRemainingSeconds}
              isExpired={permitReq.isExpired}
              onConfirm={handleConfirm}
              onRequestNew={() => permitReq.requestPermit(ticket.state)}
              isConfirming={isConfirming}
              ticket={ticket.state}
              estimatedRR={ticket.estimatedRR}
            />
          )}
        </div>
      )}
    </div>
  );
}
