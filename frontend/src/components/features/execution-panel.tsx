import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { TradeTicket } from "./trade-ticket";
import { PermitCard } from "./permit-card";
import { useAuth } from "@/hooks/useAuth";
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

export interface ExecutionResult {
  execution_id?: string;
  entry_order_id?: string;
  sl_order_id?: string;
  tp_order_id?: string;
  status?: string;
  filled_quantity?: number;
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
  const { t } = useTranslation();
  const { isAuthed, isPending: authPending } = useAuth();
  const [step, setStep] = useState<Step>("TICKET");
  const [isConfirming, setIsConfirming] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
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

  // Every execution API (permit, execute, trades) requires a session and will
  // 401 an anonymous caller. Say so up front rather than letting the trader
  // build a ticket that cannot be submitted.
  if (!authPending && !isAuthed) {
    return (
      <IqCard className={className}>
        <h3 className="text-sm font-semibold">
          {t("components.batchE.executionPanel.signInTitle")}
        </h3>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("components.batchE.executionPanel.signInBody")}
        </p>
        <Link
          to="/login"
          className="mt-4 inline-flex rounded-md border border-info/30 bg-info/10 px-3 py-1.5 text-xs font-semibold text-info transition-colors hover:bg-info/20"
        >
          {t("components.batchE.executionPanel.signInButton")}
        </Link>
      </IqCard>
    );
  }

  const handleConfirm = async () => {
    setIsConfirming(true);
    setExecutionError(null);
    setExecutionResult(null);

    try {
      // Get the permit_id from the approved permit
      const approvedPermit = permitReq.permit as PermitCardApproved;
      const permitId = approvedPermit?.permit_id;

      if (!permitId) {
        setExecutionError(t("components.batchE.executionPanel.permitIdNotFound"));
        setIsConfirming(false);
        return;
      }

      // Call the execution endpoint to submit the permit
      const executeRes = await fetch("/api/execution/execute", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permit_id: permitId }),
      });

      let executeData: unknown;
      try {
        executeData = await executeRes.json();
      } catch {
        setExecutionError(t("components.batchE.executionPanel.failedToParseResponse"));
        setIsConfirming(false);
        return;
      }

      // Check for error responses
      if (!executeRes.ok) {
        const errorResp = executeData as { error?: { message?: string }; detail?: string };
        const errorMessage = errorResp?.error?.message || errorResp?.detail;

        // Special case: kill switch (execution_disabled)
        if (executeRes.status === 409 && errorMessage?.includes("execution_disabled")) {
          setExecutionError(t("components.batchE.executionPanel.killSwitchError"));
          setIsConfirming(false);
          return;
        }

        // Other error cases
        if (executeRes.status === 503) {
          setExecutionError(t("components.batchE.executionPanel.serviceNotReady"));
        } else if (executeRes.status === 404 || executeRes.status === 410) {
          setExecutionError(t("components.batchE.executionPanel.permitExpired"));
        } else if (executeRes.status === 409) {
          setExecutionError(t("components.batchE.executionPanel.permitAlreadyUsed"));
        } else {
          setExecutionError(
            errorMessage || t("components.batchE.executionPanel.executeFailedFallback"),
          );
        }
        setIsConfirming(false);
        return;
      }

      // Success: store the execution result
      const successData = executeData as { data?: ExecutionResult; error?: null };
      if (successData?.data) {
        setExecutionResult(successData.data);
      }

      // Log the trade to the journal if context is available
      if (logContext) {
        try {
          // Mirror the approved trade into the journal so it shows up on
          // /trades with live PnL immediately. A journal-logging failure must
          // never block the execution UX — execution was already confirmed
          // server-side; only this local /trades mirror failed.
          await createTrade.mutateAsync(logContext);
        } catch (err) {
          console.error("Failed to log confirmed trade to the journal", err);
          // Non-blocking: execution succeeded, journal log is best-effort
        }
      }

      // Transition to submitted state
      setStep("SUBMITTED");
    } catch (err) {
      console.error("Execution error:", err);
      setExecutionError(
        err instanceof Error ? err.message : t("components.batchE.executionPanel.unexpectedError"),
      );
      setIsConfirming(false);
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
          {t("components.batchE.executionPanel.qualityScore", {
            score:
              (permitReq.permit as PermitCardApproved).quality?.score ||
              t("components.batchE.executionPanel.qualityScoreNotAvailable"),
          })}
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
        <>
          {executionError && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {executionError}
            </div>
          )}
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
        </>
      )}

      {step === "SUBMITTED" && (
        <IqCard className="flex flex-col items-center justify-center gap-4 py-12 text-center">
          <CheckCircle2 className="h-16 w-16 text-bullish" />
          <div className="flex flex-col gap-1">
            <h3 className="text-xl font-bold">
              {t("components.batchE.executionPanel.orderSubmittedTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("components.batchE.executionPanel.orderSubmittedBody")}
              {logContext && ` ${t("components.batchE.executionPanel.loggedAsRunningPosition")}`}
            </p>
            {executionResult?.entry_order_id && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("components.batchE.executionPanel.entryOrder", {
                  orderId: executionResult.entry_order_id,
                })}
              </p>
            )}
          </div>
          <div className="mt-4 flex items-center gap-2">
            {logContext && (
              <Button asChild size="sm">
                <Link to="/trades">{t("components.batchE.executionPanel.viewRunningTrades")}</Link>
              </Button>
            )}
            <Button onClick={handleReset} variant="outline" size="sm">
              {t("components.batchE.executionPanel.newTrade")}
            </Button>
          </div>
        </IqCard>
      )}
    </div>
  );
}
