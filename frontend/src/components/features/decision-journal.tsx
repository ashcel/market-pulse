import { Activity, CheckCircle2, MinusCircle } from "lucide-react";
import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { Badge } from "@/components/ui/badge";
import { useDecisions } from "@/hooks/useDecisions";

function metric(outcome: Record<string, unknown> | null, key: string) {
  const value = outcome?.[key];
  return typeof value === "number" ? value.toFixed(2) : "Pending";
}

export function DecisionJournal() {
  const { decisions, isLoading, error } = useDecisions();
  const accepted = decisions.filter(
    (d) => d.user_action === "accepted_skip" || d.user_action === "took_trade",
  ).length;
  const skipped = decisions.filter(
    (d) => d.user_action === "rejected_skip" || d.user_action === "ignored",
  ).length;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <CardEyebrow>Decision Quality</CardEyebrow>
        <h2 className="mt-1 text-lg font-bold">Thesis vs Execution</h2>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <IqCard className="flex items-center gap-3">
          <CheckCircle2 className="text-bullish" />
          <div>
            <div className="text-2xl font-bold">{accepted}</div>
            <div className="text-xs text-muted-foreground">Accepted</div>
          </div>
        </IqCard>
        <IqCard className="flex items-center gap-3">
          <MinusCircle className="text-warning" />
          <div>
            <div className="text-2xl font-bold">{skipped}</div>
            <div className="text-xs text-muted-foreground">Skipped</div>
          </div>
        </IqCard>
      </div>
      {isLoading && <p className="text-sm text-muted-foreground">Loading decisions...</p>}
      {error && <p className="text-sm text-destructive">Decision history unavailable.</p>}
      {!isLoading && decisions.length === 0 && (
        <IqCard className="text-sm text-muted-foreground">
          Run a Skip Check to start measuring advice against outcomes.
        </IqCard>
      )}
      {decisions.map((decision) => (
        <IqCard key={decision.id} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <strong>{decision.symbol}</strong>
            <Badge variant="outline">{decision.objective}</Badge>
            <Badge variant="outline">{decision.direction}</Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {new Date(decision.created_at).toLocaleString()}
            </span>
          </div>
          <div className="grid gap-3 text-xs sm:grid-cols-2">
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="font-semibold">Thesis</div>
              <div className="mt-1 text-muted-foreground">Verdict: {decision.verdict_at_time}</div>
              <div className="text-muted-foreground">
                Action: {decision.user_action ?? "Undecided"}
              </div>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="font-semibold">Execution / outcome</div>
              <div className="mt-1 text-muted-foreground">
                PnL: {metric(decision.actual_outcome, "pnl")}
              </div>
              <div className="text-muted-foreground">
                MFE / MAE: {metric(decision.actual_outcome, "mfe")} /{" "}
                {metric(decision.actual_outcome, "mae")}
              </div>
            </div>
          </div>
        </IqCard>
      ))}
    </section>
  );
}
