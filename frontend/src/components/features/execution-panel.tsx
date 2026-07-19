import { useEffect, useState } from "react";
import { TradeTicket } from "./trade-ticket";
import { PermitCard } from "./permit-card";
import { useTradeTicket } from "@/hooks/useTradeTicket";
import { usePermit } from "@/hooks/usePermit";
import { IqCard } from "@/components/features/iq-card";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import type { PermitCardApproved } from "@/lib/types/execution";
import type { TradeTicketState } from "@/hooks/useTradeTicket";

type Step = "TICKET" | "PERMIT" | "SUBMITTED";

export function ExecutionPanel({
  initialTicket,
  className,
}: {
  initialTicket?: Partial<TradeTicketState>;
  className?: string;
}) {
  const [step, setStep] = useState<Step>("TICKET");
  const [isConfirming, setIsConfirming] = useState(false);
  const ticket = useTradeTicket(initialTicket);
  const permitReq = usePermit();

  useEffect(() => {
    if (!initialTicket) return;
    ticket.replace(initialTicket);
    permitReq.clearPermit();
    setStep("TICKET");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialTicket)]);

  const handleRequestPermit = async () => {
    await permitReq.requestPermit(ticket.state);
    setStep("PERMIT");
  };

  const handleConfirm = async () => {
    setIsConfirming(true);
    // In a real implementation, this would call an execution API with the permit ID
    // For now, simulate a network request
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setIsConfirming(false);
    setStep("SUBMITTED");
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
        />
      )}

      {step === "SUBMITTED" && (
        <IqCard className="flex flex-col items-center justify-center gap-4 py-12 text-center">
          <CheckCircle2 className="h-16 w-16 text-bullish" />
          <div className="flex flex-col gap-1">
            <h3 className="text-xl font-bold">Trade Submitted</h3>
            <p className="text-sm text-muted-foreground">
              Your order has been sent to the execution engine.
            </p>
          </div>
          <Button onClick={handleReset} className="mt-4" variant="outline">
            New Trade
          </Button>
        </IqCard>
      )}
    </div>
  );
}
