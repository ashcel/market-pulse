import { useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleX,
  Minus,
  AlertTriangle,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Activity,
  Target,
  Gauge,
  Lock,
  Waypoints,
  Info,
} from "lucide-react";

import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonCard } from "@/components/features/skeletons";
import {
  useSkipCheck,
  type SkipCheckAnswer,
  type SkipBlock,
  type SkipBlockKind,
} from "@/hooks/useSkipCheck";
import { cn } from "@/lib/utils";
import { setDecisionAction } from "@/hooks/useDecisions";

const BLOCK_ICON: Record<SkipBlockKind, typeof CheckCircle2> = {
  constitution_headroom: Lock,
  loss_budget: AlertTriangle,
  portfolio_exposure: ShieldAlert,
  account_state: Activity,
  risk_reward: Target,
  liquidation_buffer: TrendingDown,
  behavior: AlertTriangle,
  objective_fit: Gauge,
  regime_fit: Waypoints,
  catalyst_window: Info,
};

const STATUS_STYLE: Record<string, string> = {
  supportive: "border-bullish/30 bg-bullish-soft",
  caution: "border-warning/30 bg-warning-soft",
  no_opinion: "border-border bg-muted/40",
};

const STATUS_ICON: Record<string, typeof CheckCircle2> = {
  supportive: CheckCircle2,
  caution: CircleAlert,
  no_opinion: Minus,
};

function SkipBlockCard({ block }: { block: SkipBlock }) {
  const Icon = BLOCK_ICON[block.kind] ?? Info;
  const StatusIcon = STATUS_ICON[block.status] ?? Minus;

  return (
    <div
      className={cn("flex gap-2.5 rounded-lg border p-3 text-[12px]", STATUS_STYLE[block.status])}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <StatusIcon
            className={cn(
              "h-3.5 w-3.5",
              block.status === "supportive" && "text-bullish",
              block.status === "caution" && "text-warning",
              block.status === "no_opinion" && "text-muted-foreground",
            )}
          />
          <span className="font-semibold">{block.headline}</span>
          {block.blocking && (
            <Badge
              variant="outline"
              className="text-[9px] px-1 py-0 text-warning border-warning/40"
            >
              Blocking
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-muted-foreground">{block.detail}</p>
        {block.evidence.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {block.evidence.map((e, i) => (
              <span
                key={i}
                className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {e.label}: {e.value}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AnswerBanner({ answer }: { answer: SkipCheckAnswer }) {
  const tone =
    answer.answer === "supportive"
      ? "border-bullish/30 bg-bullish-soft text-bullish"
      : answer.answer === "caution"
        ? "border-warning/30 bg-warning-soft text-warning"
        : "border-border bg-muted/40 text-muted-foreground";

  const Icon =
    answer.answer === "supportive"
      ? CheckCircle2
      : answer.answer === "caution"
        ? CircleAlert
        : CircleX;

  return (
    <div className={cn("flex items-center gap-3 rounded-lg border p-3", tone)}>
      <Icon className="h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-sm capitalize">{answer.answer}</div>
        <p className="text-[11px] opacity-80">{answer.headline}</p>
      </div>
      <Badge
        variant="outline"
        className={
          answer.viable ? "text-bullish border-bullish/40" : "text-bearish border-bearish/40"
        }
      >
        {answer.viable ? "Viable" : "Not viable"}
      </Badge>
    </div>
  );
}

export function SkipCheckPanel({
  symbol,
  objective,
  direction,
  entryPrice,
  stopLoss,
  takeProfit,
  leverage,
  verdict,
  context,
  disabled,
  onClose,
  onTrade,
}: {
  symbol: string;
  objective: string;
  direction: "long" | "short" | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  leverage?: number | null;
  verdict?: import("@/hooks/useSkipCheck").VerdictContextInput | null;
  context?: import("@/hooks/useSkipCheck").SkipCheckRequest["context"];
  disabled?: boolean;
  onClose?: () => void;
  onTrade?: (decisionId: string) => void;
}) {
  const [show, setShow] = useState(false);
  const [selectedDirection, setSelectedDirection] = useState<"long" | "short" | null>(direction);
  const { answer, decisionId, loading, error, runCheck, clear } = useSkipCheck();

  const handleRun = async () => {
    setShow(true);
    if (!selectedDirection) return;
    await runCheck({
      symbol,
      objective: objective as "scalp" | "intraday" | "swing",
      direction: selectedDirection.toUpperCase() as "LONG" | "SHORT",
      entry_price: entryPrice ?? null,
      planned_stop: stopLoss ?? null,
      take_profit: takeProfit ?? null,
      leverage: leverage ?? null,
      verdict,
      context,
    });
  };

  const handleClose = () => {
    if (decisionId) void setDecisionAction(decisionId, "ignored").catch(() => {});
    setShow(false);
    clear();
    onClose?.();
  };

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => (direction ? void handleRun() : setShow(true))}
        disabled={loading || disabled}
        className="gap-1.5 text-[11px]"
      >
        {loading ? (
          <>Checking…</>
        ) : (
          <>
            <Activity className="h-3.5 w-3.5" />
            Skip Check
          </>
        )}
      </Button>

      {show && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={handleClose} />
          <div className="relative max-h-[85vh] w-full overflow-y-auto rounded-t-xl bg-card p-4 shadow-lg sm:max-w-lg sm:rounded-xl">
            <div className="mb-4 flex items-center justify-between">
              <CardEyebrow>Skip Check — {symbol}</CardEyebrow>
              <button
                type="button"
                onClick={handleClose}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            {context && (
              <div className="mb-3 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                <Badge variant="outline">Account: {context.accountFreshness ?? "unknown"}</Badge>
                <Badge variant="outline">
                  Environment: {import.meta.env.DEV ? "demo" : "live"}
                </Badge>
                {context.tradeQualityScore != null && (
                  <Badge variant="outline">TQS {context.tradeQualityScore}</Badge>
                )}
                {context.behaviorFlags?.map((flag) => (
                  <Badge key={flag} variant="outline" className="text-warning">
                    {flag}
                  </Badge>
                ))}
              </div>
            )}

            {!selectedDirection && (
              <div className="mb-4 rounded-lg border border-warning/30 bg-warning-soft p-3">
                <p className="mb-2 text-sm font-medium">Choose a direction to continue</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => setSelectedDirection("long")}>
                    Long
                  </Button>
                  <Button variant="outline" onClick={() => setSelectedDirection("short")}>
                    Short
                  </Button>
                </div>
              </div>
            )}
            {selectedDirection && !answer && !loading && !error && (
              <Button className="w-full" onClick={() => void handleRun()}>
                Run Skip Check
              </Button>
            )}

            {loading && (
              <div className="flex flex-col gap-3">
                <SkeletonCard className="h-20 w-full" />
                <SkeletonCard className="h-16 w-full" />
                <SkeletonCard className="h-16 w-full" />
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-bearish/30 bg-bearish-soft p-3 text-sm text-bearish">
                {error}
              </div>
            )}

            {answer && (
              <div className="flex flex-col gap-3">
                <AnswerBanner answer={answer} />
                {decisionId && (
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void setDecisionAction(decisionId, "rejected_skip");
                        setShow(false);
                      }}
                    >
                      Skip it
                    </Button>
                    <Button
                      disabled={!answer.viable}
                      onClick={() => {
                        void setDecisionAction(decisionId, "accepted_skip");
                        onTrade?.(decisionId);
                        setShow(false);
                      }}
                    >
                      Use this setup
                    </Button>
                  </div>
                )}

                {answer.supportive_read.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-bullish">
                      ✅ Supportive
                    </p>
                    {answer.supportive_read.map((block, i) => (
                      <SkipBlockCard key={i} block={block} />
                    ))}
                  </div>
                )}

                {answer.cautions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-warning">
                      ⚠ Cautions
                    </p>
                    {answer.cautions.map((block, i) => (
                      <SkipBlockCard key={i} block={block} />
                    ))}
                  </div>
                )}

                {answer.no_opinion.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      — No opinion
                    </p>
                    {answer.no_opinion.map((block, i) => (
                      <SkipBlockCard key={i} block={block} />
                    ))}
                  </div>
                )}

                {answer.what_flips_it.length > 0 && (
                  <div className="rounded-lg border border-border bg-surface/40 p-3">
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      What would flip this
                    </p>
                    <div className="flex flex-col gap-1">
                      {answer.what_flips_it.map((item, i) => (
                        <p key={i} className="text-[12px] text-muted-foreground">
                          {item.condition}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                {answer.permit_preview && (
                  <div className="rounded-lg border border-border bg-surface/40 p-3">
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Risk desk verdict
                    </p>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={
                          answer.permit_preview.status === "APPROVED"
                            ? "text-bullish border-bullish/40"
                            : "text-bearish border-bearish/40"
                        }
                      >
                        {answer.permit_preview.status}
                      </Badge>
                      {answer.permit_preview.quality_score != null && (
                        <span className="text-[11px] text-muted-foreground">
                          Quality: {answer.permit_preview.quality_score.toFixed(1)}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground text-center">
                  Evaluated {new Date(answer.evaluated_at).toLocaleTimeString()} · {answer.session}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
