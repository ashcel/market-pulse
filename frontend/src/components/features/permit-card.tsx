import { X, Clock, ShieldAlert, CheckCircle2, ChevronDown } from "lucide-react";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type {
  PermitResponse,
  PermitCardApproved,
  PermitCardRejected,
  CheckCardItem,
} from "@/lib/types/execution";
import type { TradeTicketState } from "@/hooks/useTradeTicket";
import { useTelegramMainButton } from "@/hooks/useTelegramMiniApp";

/** Slice of the trade ticket the permit card needs to render the hero + summary rows. */
export type PermitTicketSummary = Pick<
  TradeTicketState,
  "side" | "entry_price" | "stop_price" | "target_price" | "risk_percent"
>;

interface PermitCardProps {
  permit: PermitResponse;
  timeRemainingSeconds: number;
  isExpired: boolean;
  onConfirm: () => void;
  onRequestNew: () => void;
  isConfirming?: boolean;
  /** Ticket fields (side/entry/stop/target/risk) — the permit response itself doesn't carry these. */
  ticket?: PermitTicketSummary;
  estimatedRR?: number | null;
}

const SCORE_DISCLAIMER = "evaluation, not prediction";

const LABELS: Record<string, string> = {
  RISK_PCT_OUT_OF_BAND: "Risk per Trade",
  DAILY_LOSS_LIMIT: "Daily Loss Limit",
  WEEKLY_LOSS_LIMIT: "Weekly Loss Limit",
  MAX_LEVERAGE: "Max Leverage",
  MAX_CONCURRENT_POSITIONS: "Max Concurrent Positions",
  MAX_CORRELATED_EXPOSURE: "Max Correlated Exposure",
  RR_BELOW_MIN: "Minimum Risk/Reward",
  STOP_MISSING: "Stop Loss Required",
  SYMBOL_NOT_ALLOWED: "Allowed Symbols",
  SESSION_NOT_ALLOWED: "Allowed Trading Sessions",
  STALE_ACCOUNT_STATE: "Live Account State",
  BEHAVIOR_COOLDOWN: "Behavior Cooldowns",
};

function formatDetail(check: string, detail: string, passed: boolean): string {
  if (check === "SYMBOL_NOT_ALLOWED" && passed && detail.includes("[]")) {
    return "No symbol restriction configured";
  }
  if (check === "SESSION_NOT_ALLOWED" && passed && detail.includes("[]")) {
    return "No session restriction configured";
  }
  return detail.replace(/(\d+\.\d+)/g, (match) => {
    const num = parseFloat(match);
    if (num === Math.round(num)) return num.toString();
    return num.toFixed(2).replace(/\.?0+$/, "");
  });
}

/** Mirrors the entry<10?toPrecision(5):toFixed(2) convention used elsewhere (trade-action-overlay, token page). */
function formatPrice(value: number | "" | undefined): string {
  if (value === "" || value === undefined || value === null || Number.isNaN(Number(value))) {
    return "—";
  }
  const n = Number(value);
  return n < 10 ? n.toPrecision(5) : n.toFixed(2);
}

function checkSummary(checks: CheckCardItem[] | undefined): { passed: number; total: number } {
  if (!checks || checks.length === 0) return { passed: 0, total: 0 };
  return { passed: checks.filter((c) => c.passed).length, total: checks.length };
}

function MiniGauge({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  const hue = Math.floor((pct / 100) * 120); // 0 = red, 120 = green
  const circumference = 2 * Math.PI * 24;

  return (
    <div className="relative flex h-14 w-14 shrink-0 items-center justify-center">
      <svg viewBox="0 0 56 56" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="28" cy="28" r="24" fill="none" strokeWidth="5" className="stroke-muted" />
        <circle
          cx="28"
          cy="28"
          r="24"
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          stroke={`hsl(${hue}, 70%, 50%)`}
          strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <span className="text-base font-bold num">{pct}</span>
    </div>
  );
}

function CheckList({ items }: { items: CheckCardItem[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, idx) => (
        <div key={idx} className="flex items-start gap-3 rounded-md bg-background/60 p-2.5">
          {item.passed ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-bullish" />
          ) : (
            <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          )}
          <div className="flex flex-col">
            <span className="text-sm font-medium">{LABELS[item.check] || item.check}</span>
            {item.detail && (
              <span className="text-xs text-muted-foreground">
                {formatDetail(item.check, item.detail, item.passed)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Collapsed-by-default section: one compact pass/fail summary line, expands to per-check detail. */
function CollapsibleCheckSection({
  title,
  checks,
}: {
  title: string;
  checks: CheckCardItem[] | undefined;
}) {
  if (!checks || checks.length === 0) return null;
  const { passed, total } = checkSummary(checks);
  const allPassed = passed === total;
  const noneFailed = allPassed
    ? "text-bullish"
    : passed === 0
      ? "text-destructive"
      : "text-warning";

  return (
    <Collapsible className="rounded-md bg-muted/30">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left",
          "hover:bg-muted/50 transition-colors",
        )}
      >
        <div className="flex items-center gap-2">
          {allPassed ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-bullish" />
          ) : (
            <ShieldAlert className={cn("h-4 w-4 shrink-0", noneFailed)} />
          )}
          <span className="text-sm font-medium">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("text-xs font-semibold num", noneFailed)}>
            {passed}/{total} passed
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3 pt-1">
        <CheckList items={checks} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function PermitCard({
  permit,
  timeRemainingSeconds,
  isExpired,
  onConfirm,
  onRequestNew,
  isConfirming,
  ticket,
  estimatedRR,
}: PermitCardProps) {
  const isApproved = permit.decision.status === "APPROVED";

  // Sprint 5: inside Telegram, offer the confirm on the client's own
  // MainButton. The in-page button below stays exactly as it is — this is an
  // extra affordance for the webview, never a replacement, and it disables
  // (rather than hides) on an expired permit so the action still reads as
  // existing. No-op on the web. It must never fire for a REJECTED permit: a
  // hard-limit rejection is not something a native button may route around.
  useTelegramMainButton({
    text: isConfirming ? "Mencatat…" : "Take this trade",
    onClick: onConfirm,
    visible: isApproved,
    enabled: isApproved && !isExpired && !isConfirming,
    loading: Boolean(isConfirming),
  });

  if (!isApproved) {
    const rejected = permit as PermitCardRejected;
    return (
      <IqCard className="flex flex-col gap-5 border-destructive/50 bg-destructive/5">
        <div className="flex items-center justify-between">
          <CardEyebrow className="text-destructive">Permit Rejected</CardEyebrow>
          <ShieldAlert className="h-5 w-5 text-destructive" />
        </div>

        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold">Rejection Reasons</h4>
          <ul className="flex flex-col gap-2">
            {rejected.reasons?.map((r, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <X className="h-4 w-4 shrink-0" />
                <span className="leading-tight">{formatDetail("", r, false)}</span>
              </li>
            ))}
          </ul>
        </div>

        <Button variant="outline" onClick={onRequestNew} className="mt-2">
          Modify Ticket
        </Button>
      </IqCard>
    );
  }

  const approved = permit as PermitCardApproved;
  const isUrgent = timeRemainingSeconds > 0 && timeRemainingSeconds <= 30;
  const side = ticket?.side;

  return (
    <IqCard
      className={cn(
        "flex flex-col gap-5",
        isExpired ? "border-border opacity-80" : "border-bullish/30",
      )}
    >
      <div className="flex items-center justify-between">
        <CardEyebrow className={isExpired ? "text-muted-foreground" : "text-bullish"}>
          {isExpired ? "Permit Expired" : "Permit Approved"}
        </CardEyebrow>
        {isExpired ? (
          <div className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Expired
          </div>
        ) : (
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold num",
              isUrgent ? "bg-warning/20 text-warning" : "bg-bullish/20 text-bullish",
            )}
          >
            <Clock className="h-3.5 w-3.5" />
            {timeRemainingSeconds}s remaining
          </div>
        )}
      </div>

      {/* HERO — direction / quality / est. R:R / risk, at a glance */}
      <div className="flex flex-col gap-1.5">
        <div className="grid grid-cols-4 gap-2 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-col items-center justify-center gap-1">
            <span
              className={cn(
                "text-lg font-black leading-none tracking-tight",
                side === "SHORT" ? "text-bearish" : "text-bullish",
              )}
            >
              {side ?? "—"}
            </span>
            <span className="text-[9px] uppercase leading-tight tracking-wider text-muted-foreground">
              Direction
            </span>
          </div>

          <div className="flex flex-col items-center justify-center gap-1">
            {approved.quality ? (
              <MiniGauge score={approved.quality.score} />
            ) : (
              <span className="text-lg font-bold num">—</span>
            )}
            <span
              className="max-w-full truncate text-[9px] uppercase leading-tight tracking-wider text-muted-foreground"
              title={approved.quality?.label}
            >
              {approved.quality?.label || "Quality"}
            </span>
          </div>

          <div className="flex flex-col items-center justify-center gap-1">
            <span className="text-lg font-bold leading-none num">
              {estimatedRR != null ? `${estimatedRR.toFixed(2)}R` : "—"}
            </span>
            <span className="text-[9px] uppercase leading-tight tracking-wider text-muted-foreground">
              Est. R:R
            </span>
          </div>

          <div className="flex flex-col items-center justify-center gap-1">
            <span className="text-lg font-bold leading-none num">
              {ticket ? `${ticket.risk_percent.toFixed(1)}%` : "—"}
            </span>
            <span className="text-[9px] uppercase leading-tight tracking-wider text-muted-foreground">
              Risk
            </span>
          </div>
        </div>
        {approved.quality && (
          <span className="text-center text-[10px] uppercase tracking-wider text-muted-foreground">
            {SCORE_DISCLAIMER}
          </span>
        )}
      </div>

      {/* TRADE SUMMARY — entry / stop / target / size, single target only */}
      {ticket && (
        <div className="grid grid-cols-4 gap-2 text-center">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold num">{formatPrice(ticket.entry_price)}</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Entry
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-bearish num">
              {formatPrice(ticket.stop_price)}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Stop</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-bullish num">
              {formatPrice(ticket.target_price)}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Target
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs italic leading-tight text-muted-foreground">
              At submission
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Size</span>
          </div>
        </div>
      )}

      <Separator />

      {/* PROGRESSIVE DISCLOSURE — collapsed summary, expand for per-check detail */}
      <div className="flex flex-col gap-2">
        <CollapsibleCheckSection title="Constitution" checks={approved.constitution?.checks} />
        <CollapsibleCheckSection title="Portfolio Risk" checks={approved.portfolio_risk?.checks} />
        <CollapsibleCheckSection title="Daily Budget" checks={approved.daily_budget?.checks} />
      </div>

      <div className="mt-1 flex flex-col gap-3">
        <div className="flex gap-3">
          <Button
            variant={isExpired ? "default" : "outline"}
            className="flex-1"
            onClick={onRequestNew}
          >
            {isExpired ? "Request New Permit" : "Back"}
          </Button>
          <Button
            className="flex-[2] bg-bullish text-white font-bold hover:bg-bullish/90"
            disabled={isExpired || isConfirming}
            onClick={onConfirm}
          >
            {isConfirming ? "Mencatat…" : "Take this trade"}
          </Button>
        </div>
      </div>
    </IqCard>
  );
}
