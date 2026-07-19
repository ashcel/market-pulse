import { Check, X, Clock, ShieldAlert, CheckCircle2 } from "lucide-react";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PermitResponse,
  PermitCardApproved,
  PermitCardRejected,
  CheckCardItem,
} from "@/lib/types/execution";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface PermitCardProps {
  permit: PermitResponse;
  timeRemainingSeconds: number;
  isExpired: boolean;
  onConfirm: () => void;
  onRequestNew: () => void;
  isConfirming?: boolean;
}

const SCORE_DISCLAIMER = "evaluation, not prediction";

function Gauge({ score }: { score: number }) {
  const percentage = Math.max(0, Math.min(100, score));
  const hue = Math.floor((percentage / 100) * 120); // 0 = red, 120 = green

  return (
    <div className="flex flex-col items-center gap-1 py-4">
      <div className="relative flex h-24 w-48 items-end justify-center overflow-hidden">
        <div className="absolute top-0 h-48 w-48 rounded-full border-[16px] border-muted" />
        <div
          className="absolute top-0 h-48 w-48 rounded-full border-[16px] border-b-transparent border-r-transparent transition-all duration-1000 ease-in-out"
          style={{
            borderColor: `hsl(${hue}, 70%, 50%)`,
            borderBottomColor: "transparent",
            borderRightColor: "transparent",
            transform: `rotate(${-135 + (percentage / 100) * 180}deg)`,
          }}
        />
        <div className="mb-2 text-3xl font-bold num">{percentage}</div>
      </div>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {SCORE_DISCLAIMER}
      </span>
    </div>
  );
}

function CheckList({ items }: { items: CheckCardItem[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, idx) => (
        <div key={idx} className="flex items-start gap-3 rounded-md bg-muted/30 p-2.5">
          {item.passed ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-bullish" />
          ) : (
            <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          )}
          <div className="flex flex-col">
            <span className="text-sm font-medium">{item.check}</span>
            {item.detail && <span className="text-xs text-muted-foreground">{item.detail}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PermitCard({
  permit,
  timeRemainingSeconds,
  isExpired,
  onConfirm,
  onRequestNew,
  isConfirming,
}: PermitCardProps) {
  const isApproved = permit.decision.status === "APPROVED";

  if (!isApproved) {
    const rejected = permit as PermitCardRejected;
    return (
      <IqCard className="flex flex-col gap-5 border-destructive/50 bg-destructive/5">
        <div className="flex items-center justify-between">
          <CardEyebrow className="text-destructive">Permit Rejected</CardEyebrow>
          <ShieldAlert className="h-5 w-5 text-destructive" />
        </div>

        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold">Rejection Reasons:</h4>
          <ul className="flex flex-col gap-2">
            {rejected.reasons?.map((r, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <X className="h-4 w-4" />
                {r}
              </li>
            ))}
          </ul>
        </div>

        <Button variant="outline" onClick={onRequestNew} className="mt-4">
          Modify Ticket
        </Button>
      </IqCard>
    );
  }

  const approved = permit as PermitCardApproved;
  const isUrgent = timeRemainingSeconds > 0 && timeRemainingSeconds <= 30;

  return (
    <IqCard
      className={cn(
        "flex flex-col gap-5 border-bullish/30",
        isExpired ? "opacity-75 grayscale transition-all" : "",
      )}
    >
      <div className="flex items-center justify-between">
        <CardEyebrow className="text-bullish">Permit Approved</CardEyebrow>
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
            isExpired
              ? "bg-muted text-muted-foreground"
              : isUrgent
                ? "bg-warning/20 text-warning"
                : "bg-bullish/20 text-bullish",
          )}
        >
          <Clock className="h-3.5 w-3.5" />
          {isExpired ? "EXPIRED" : `${timeRemainingSeconds}s remaining`}
        </div>
      </div>

      {approved.quality && (
        <div className="flex flex-col items-center border-b border-border pb-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {approved.quality.label || "Trade Quality"}
          </h4>
          <Gauge score={approved.quality.score} />
        </div>
      )}

      <Accordion type="multiple" defaultValue={["constitution"]} className="w-full">
        {approved.constitution?.checks && (
          <AccordionItem value="constitution">
            <AccordionTrigger className="py-3 text-sm font-semibold">
              Constitution Checks
            </AccordionTrigger>
            <AccordionContent>
              <CheckList items={approved.constitution.checks} />
            </AccordionContent>
          </AccordionItem>
        )}

        {approved.portfolio_risk?.checks && (
          <AccordionItem value="portfolio">
            <AccordionTrigger className="py-3 text-sm font-semibold">
              Portfolio Risk
            </AccordionTrigger>
            <AccordionContent>
              <CheckList items={approved.portfolio_risk.checks} />
            </AccordionContent>
          </AccordionItem>
        )}

        {approved.daily_budget?.checks && (
          <AccordionItem value="budget">
            <AccordionTrigger className="py-3 text-sm font-semibold">Daily Budget</AccordionTrigger>
            <AccordionContent>
              <CheckList items={approved.daily_budget.checks} />
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>

      <div className="mt-2 flex flex-col gap-3">
        {isExpired ? (
          <div className="text-center text-sm font-semibold text-destructive">
            PERMIT EXPIRED - request new permit
          </div>
        ) : null}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onRequestNew}>
            Back
          </Button>
          <Button
            className="flex-2 bg-bullish hover:bg-bullish/90 text-white font-bold"
            disabled={isExpired || isConfirming}
            onClick={onConfirm}
          >
            {isConfirming ? "Confirming..." : "Confirm Trade"}
          </Button>
        </div>
      </div>
    </IqCard>
  );
}
