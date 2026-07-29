import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
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

export interface ExecutionResult {
  execution_id?: string;
  entry_order_id?: string;
  sl_order_id?: string;
  tp_order_id?: string;
  status?: string;
  filled_quantity?: number;
}

const DEPTH_PREF_KEY = "iq-ticket-depth-open";

/** Live status strip: submitted → filled → PROTECTED. */
function StatusStrip({ result }: { result: ExecutionResult }) {
  const status = (result.status ?? "").toUpperCase();
  const filled =
    Boolean(result.filled_quantity) || status.includes("FILL") || status === "PROTECTED";
  const protectedNow = Boolean(result.sl_order_id) || status === "PROTECTED";
  const steps = [
    { label: "Submitted", done: true },
    { label: "Filled", done: filled },
    { label: "Protected", done: protectedNow },
  ];
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
              s.done ? "bg-bullish/20 text-bullish" : "bg-muted text-muted-foreground",
            )}
          >
            {s.label === "Protected" && s.done ? (
              <ShieldCheck className="h-3.5 w-3.5" />
            ) : s.done ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {s.label}
          </div>
          {i < steps.length - 1 && <span className="text-muted-foreground/40">→</span>}
        </div>
      ))}
    </div>
  );
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
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
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
    setExecutionResult(null);
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
    if (!validKey || executionResult) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void permitReq.requestPermit(ticket.state);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validKey]);

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
        setExecutionError("Failed to parse execution response");
        setIsConfirming(false);
        return;
      }

      if (!executeRes.ok) {
        const errorResp = executeData as { error?: { message?: string }; detail?: string };
        const errorMessage = errorResp?.error?.message || errorResp?.detail;
        if (executeRes.status === 409 && errorMessage?.includes("execution_disabled")) {
          setExecutionError(
            "Live execution is off (testnet kill switch). The permit is approved but no order was placed.",
          );
        } else if (executeRes.status === 503) {
          setExecutionError("Execution service is not ready. Try again in a moment.");
        } else if (executeRes.status === 404 || executeRes.status === 410) {
          setExecutionError("Permit expired. Adjust the ticket to re-request.");
        } else if (executeRes.status === 409) {
          setExecutionError("Permit already used. Adjust the ticket to re-request.");
        } else {
          setExecutionError(errorMessage || "Failed to execute trade.");
        }
        setIsConfirming(false);
        return;
      }

      const successData = executeData as { data?: ExecutionResult };
      if (successData?.data) setExecutionResult(successData.data);
      if (decisionId) {
        await setDecisionAction(decisionId, "took_trade", {
          permit_id: permitId,
          execution_id: successData.data?.execution_id,
          status: successData.data?.status,
        });
      }

      if (logContext) {
        try {
          await createTrade.mutateAsync(logContext);
        } catch (err) {
          console.error("Failed to log confirmed trade to the journal", err);
        }
      }
    } catch (err) {
      setExecutionError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsConfirming(false);
    }
  };

  const handleReset = () => {
    ticket.reset();
    permitReq.clearPermit();
    setExecutionResult(null);
    setExecutionError(null);
  };

  // Submitted state — show the live protection strip.
  if (executionResult) {
    return (
      <div className={className ?? "mx-auto w-full max-w-md"}>
        <IqCard className="flex flex-col items-center gap-4 py-10 text-center">
          <ShieldCheck className="h-12 w-12 text-bullish" />
          <h3 className="text-lg font-bold">Order Submitted</h3>
          <StatusStrip result={executionResult} />
          {executionResult.entry_order_id && (
            <p className="text-xs text-muted-foreground">
              Entry Order · {executionResult.entry_order_id}
            </p>
          )}
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
