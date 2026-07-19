import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { TradeTicket } from "./trade-ticket";
import { PermitCard } from "./permit-card";
import { useTradeTicket } from "@/hooks/useTradeTicket";
import { usePermit } from "@/hooks/usePermit";
import { useCreateTrade } from "@/hooks/useTrades";
import { IqCard } from "@/components/features/iq-card";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import type { PermitCardApproved } from "@/lib/types/execution";
import type { TradeTicketState } from "@/hooks/useTradeTicket";

type Step = "TICKET" | "PERMIT" | "SUBMITTED";

/**
 * Plan-derived numbers used to mirror a confirmed trade into the journal
 * (`/trades`, see useCreateTrade) the instant it's placed here — so the
 * trader never has to re-enter what the engine's plan already computed.
 * Presentation/wiring only: this does not touch permit or engine semantics.
 */
export interface ExecutionLogContext {
  symbol: string;
  direction: "long" | "short";
  entry_price: number;
  quantity: number;
  leverage?: number;
  strategy?: string;
}

export function ExecutionPanel({
  initialTicket,
  className,
  logContext,
}: {
  initialTicket?: Partial<TradeTicketState>;
  className?: string;
  /** When present, a confirmed trade is also logged as a running position via useCreateTrade. */
  logContext?: ExecutionLogContext;
}) {
  const [step, setStep] = useState<Step>("TICKET");
  const [isConfirming, setIsConfirming] = useState(false);
  const ticket = useTradeTicket(initialTicket);
  const permitReq = usePermit();
  const createTrade = useCreateTrade();

  const handleRequestPermit = async () => {
    await permitReq.requestPermit(ticket.state);
    setStep("PERMIT");
  };

  useEffect(() => {
    if (!initialTicket) return;
    ticket.replace(initialTicket);
    permitReq.clearPermit();
    setStep("TICKET");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialTicket)]);

  const handleConfirm = async () => {
    setIsConfirming(true);
    try {
      if (logContext) {
        // Mirror the approved trade into the journal so it shows up on
        // /trades with live PnL immediately. A journal-logging failure must
        // never block the confirm UX — the permit was already approved
        // server-side; only this local /trades mirror failed.
        await createTrade.mutateAsync(logContext);
      } else {
        // No plan-derived context available (e.g. ticket opened without an
        // active engine plan) — preserve the prior simulated-confirm delay.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error("Failed to log confirmed trade to the journal", err);
    } finally {
      setIsConfirming(false);
      setStep("SUBMITTED");
    }
  };

  const handleReset = () => {
    ticket.reset();
    permitReq.clearPermit();
    setStep("TICKET");
  };

  return (
    <div className={className ?? "mx-auto w-full max-w-md"}>
      {/* Optionally show last quality score if available across steps */}
      {step === "SUBMITTED" && permitReq.permit?.decision?.status === "APPROVED" && (
        <div className="mb-4 text-center text-xs text-muted-foreground">
          Quality Score: {(permitReq.permit as PermitCardApproved).quality?.score || "N/A"}
        </div>
      )}

      {step === "TICKET" && (
        <>
          {permitReq.error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {permitReq.error}
            </div>
          )}
          <TradeTicket
            state={ticket.state}
            setField={ticket.setField}
            isValid={ticket.isValid}
            estimatedRR={ticket.estimatedRR}
            onSubmit={handleRequestPermit}
            isSubmitting={permitReq.loading}
          />
        </>
      )}

      {step === "PERMIT" && permitReq.permit && (
        <PermitCard
          permit={permitReq.permit}
          timeRemainingSeconds={permitReq.timeRemainingSeconds}
          isExpired={permitReq.isExpired}
          onConfirm={handleConfirm}
          onRequestNew={() => setStep("TICKET")}
          isConfirming={isConfirming}
          ticket={ticket.state}
          estimatedRR={ticket.estimatedRR}
        />
      )}

      {step === "SUBMITTED" && (
        <IqCard className="flex flex-col items-center justify-center gap-4 py-12 text-center">
          <CheckCircle2 className="h-16 w-16 text-bullish" />
          <div className="flex flex-col gap-1">
            <h3 className="text-xl font-bold">Trade Submitted</h3>
            <p className="text-sm text-muted-foreground">
              {logContext
                ? "Your order has been sent to the execution engine and logged as a running position."
                : "Your order has been sent to the execution engine."}
            </p>
          </div>
          <div className="mt-4 flex items-center gap-2">
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
      )}
    </div>
  );
}
