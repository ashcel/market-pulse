import { useEffect, useMemo, useState } from "react";
import { Brain, Zap } from "lucide-react";

import { ExecutionPanel, type ExecutionLogContext } from "@/components/features/execution-panel";
import { MarkdownText } from "@/components/features/markdown-text";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { ExternalContext } from "@/lib/engine/external-context";
import type { TradeTicketState } from "@/hooks/useTradeTicket";
import { resolveAiConfig } from "@/lib/ai/providers";
import { runAiAnalyst } from "@/lib/ai/client";
import { buildAnalystSystem, type ChartStructure } from "@/lib/ai/analyst-context";
import { formatEntryRange, formatMoney } from "@/lib/utils/format";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { cn } from "@/lib/utils";
import { InfoHint } from "@/components/features/token/shared";
import { formatHeldFor } from "@/components/features/token/verdict-cards";

export function TradeDrawer({
  symbol,
  ticket,
  logContext,
  open,
  onOpenChange,
  timeframe,
  evaluation,
  assessment,
  chartStructure,
  externalContext,
  decisionId,
}: {
  symbol: string;
  ticket: Partial<TradeTicketState>;
  logContext?: ExecutionLogContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeframe?: TokenTimeframe;
  evaluation?: SignalEvaluation;
  assessment?: DisplayIntentAssessment | null;
  chartStructure?: ChartStructure | null;
  externalContext?: ExternalContext | null;
  decisionId?: string | null;
}) {
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const aiProvider = useAiSettingsStore((s) => s.provider);
  const aiApiKeys = useAiSettingsStore((s) => s.apiKeys);
  const aiModels = useAiSettingsStore((s) => s.models);
  const aiCustomBaseUrl = useAiSettingsStore((s) => s.customBaseUrl);
  const aiConfig = useMemo(
    () =>
      resolveAiConfig({
        provider: aiProvider,
        apiKeys: aiApiKeys,
        models: aiModels,
        customBaseUrl: aiCustomBaseUrl,
      }),
    [aiProvider, aiApiKeys, aiModels, aiCustomBaseUrl],
  );

  useEffect(() => {
    if (!open || !evaluation || analysis || loading) return;

    const fallback = () =>
      deterministicFallback({
        symbol,
        range: timeframe || "1H",
        evaluation,
        assessment: assessment || null,
        thinkingMode: false,
      });

    if (!aiConfig) {
      setAnalysis(fallback());
      return;
    }

    setLoading(true);
    const system = buildAnalystSystem(
      symbol,
      timeframe || "1H",
      evaluation,
      assessment || null,
      false, // thinkingMode
      chartStructure || null,
      externalContext || null,
    );

    runAiAnalyst({
      config: aiConfig,
      system,
      messages: [
        {
          role: "user",
          content:
            "Provide a concise, 1-2 sentence quick note summarizing the core logic of this trade setup. Keep it very brief.",
        },
      ],
    })
      .then((text) => setAnalysis(text))
      .catch(() => setAnalysis(fallback()))
      .finally(() => setLoading(false));
  }, [
    open,
    evaluation,
    analysis,
    loading,
    aiConfig,
    symbol,
    timeframe,
    assessment,
    chartStructure,
    externalContext,
  ]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2 pr-10">
          <div className="flex min-w-0 items-center gap-2">
            <Zap className="h-4 w-4 shrink-0 text-primary" />
            <SheetTitle className="truncate text-xs font-bold">{symbol} Trade</SheetTitle>
            <InfoHint text="Requests a constitution-gated permit using this token's current execution plan. The backend rechecks account state and derives executable quantity from the persisted permit snapshot." />
          </div>
          {/* Echo the plan this was opened from, so the drawer never reads as
              a disconnected detour from the Plan tab it was launched from. */}
          {assessment?.plan && assessment.direction !== "none" && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] font-bold uppercase",
                  assessment.direction === "short"
                    ? "border-bearish/30 bg-bearish-soft text-bearish"
                    : "border-bullish/30 bg-bullish-soft text-bullish",
                )}
              >
                {assessment.direction}
              </Badge>
              <span className="num text-muted-foreground">
                Entry {formatEntryRange(assessment.plan.entryLow, assessment.plan.entryHigh)} · Stop{" "}
                {formatMoney(assessment.plan.stop)} · T1 {formatMoney(assessment.plan.target1)}
              </span>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 flex flex-col gap-4">
          <ExecutionPanel
            initialTicket={ticket}
            logContext={logContext}
            decisionId={decisionId}
            className="w-full"
          />

          {evaluation && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex items-center gap-2 font-bold mb-2 text-muted-foreground text-[10px] uppercase tracking-wider">
                <Brain className="h-3.5 w-3.5" /> Setup Analysis
              </div>
              {loading ? (
                <div className="animate-pulse text-muted-foreground italic text-xs">
                  Generating AI Analysis...
                </div>
              ) : (
                <div className="prose prose-sm dark:prose-invert text-xs leading-relaxed max-w-none">
                  {analysis && <MarkdownText text={analysis} />}
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
export function deterministicFallback(req: {
  symbol: string;
  range: string;
  evaluation: SignalEvaluation;
  assessment?: DisplayIntentAssessment | null;
  question?: string;
  thinkingMode: boolean;
}): string {
  const e = req.evaluation;
  const held = req.assessment?.hold.isHeld;
  const lines = [
    `### Quant memo: ${req.assessment ? req.assessment.headline : e.decision.replaceAll("-", " ")}`,
    ``,
    ...(req.assessment
      ? [
          `- **Your objective (${req.assessment.definition.label}):** ${req.assessment.summary}`,
          ...(held
            ? [
                `- **Held call:** this verdict was adopted ${formatHeldFor(req.assessment.hold.heldAt)} ago and stands until its own trigger fires — the setup below is live and may have already moved on without releasing it.`,
              ]
            : []),
        ]
      : []),
    `- **Setup:** ${e.setupType.replaceAll("-", " ")}`,
    `- **Regime:** ${e.regime.replaceAll("-", " ")}`,
    `- **Signal strength:** ${e.confidence}/100 (heuristic checklist score, not a win probability)`,
    `- **Risk plan:** entry zone \`${e.risk.entryLow}–${e.risk.entryHigh}\`, stop \`${e.risk.stop}\`, target 1 \`${e.risk.target1}\`, target 2 \`${e.risk.target2}\``,
    `- **Position:** ${e.risk.positionSize} units, max loss \`${e.risk.maxDollarLoss}\`, target 1 reward \`${e.risk.rewardRisk1}R\``,
  ];
  if (e.noTradeReasons.length) {
    lines.push(`- **Primary blocker:** ${e.noTradeReasons[0]}`);
  } else {
    lines.push(`- **Action:** ${e.reason}`);
  }
  const strongest = [...e.components].sort((a, b) => b.score - a.score)[0];
  const weakest = [...e.components].sort((a, b) => a.score - b.score)[0];
  if (strongest) lines.push(`- **Best evidence:** ${strongest.name} - ${strongest.explanation}`);
  if (weakest && weakest.score < 0)
    lines.push(`- **Risk evidence:** ${weakest.name} - ${weakest.explanation}`);
  if (req.question) lines.push(`\n### Prompt\n- ${req.question}`);
  return lines.join("\n");
}
