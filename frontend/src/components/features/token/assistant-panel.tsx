import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  Bookmark,
  BookmarkCheck,
  Brain,
  CheckCircle2,
  CircleAlert,
  History,
  Send,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { AnticipatoryReadCard } from "@/components/features/anticipatory-read-card";
import { PoiMapCard } from "@/components/features/poi-map-card";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { StructureAlignmentCard } from "@/components/features/structure-alignment-card";
import { TokenEventsCard } from "@/components/features/token-events-card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NotSignedInError, useFollowSignal, useTrackedFollows } from "@/hooks/useTrackedFollows";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import type { MarketStructure } from "@/lib/engine/structure";
import type { PerpRead } from "@/lib/engine/perp";
import type { SessionLevel } from "@/lib/engine/sessions";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { UnifiedPoi } from "@/lib/engine/poi-map";
import type { SetupValidityResult } from "@/lib/engine/setup-validity";
import { formatEntryRange, formatMoney, formatUnits } from "@/lib/utils/format";
import { usePreferencesStore } from "@/stores/preferences";
import { cn } from "@/lib/utils";
import { InfoHint, LevelStat, RiskMetric } from "@/components/features/token/shared";
import {
  HoldNote,
  MarketPhaseNote,
  PlanLadder,
  PlanRow,
  SizingNote,
  planEmptyMessage,
} from "@/components/features/token/verdict-cards";
import {
  LocationRow,
  PerpContextCard,
  PerpLeverage,
  LiquidationCheck,
  SessionLevelsCard,
} from "@/components/features/token/plan-cards";
import {
  BiasCell,
  KeyInsightBox,
  StatusBadge,
  StatusIcon,
  keyInsights,
} from "@/components/features/token/detail-cards";
import { AnticipatoryRecordNote } from "@/components/features/token/evidence-cards";

/**
 * Layer 2/3 right column of the verdict-first token page (IA redesign §4.4).
 * The verdict itself now lives in the always-visible header; this column
 * carries the action (the execution plan + permit path, visible only when a
 * setup is payable) and, one level down in a collapsed accordion, the evidence
 * — grouped as *Why this verdict*, *Track record*, and *Context*. The AI
 * analyst stays reachable via a secondary button, never primary.
 */
export function AssistantPanel({
  symbol,
  assessments,
  active,
  marketOutlook,
  structuresByTimeframe,
  perp,
  sessionLevels,
  price,
  liveData,
  poiMap,
  poiTimeframe,
  setupValidity,
  evidenceOpen,
  onEvidenceOpen,
  onOpenTrade,
  className,
}: {
  symbol: string;
  assessments: DisplayIntentAssessment[];
  active: DisplayIntentAssessment | null;
  marketOutlook: string;
  structuresByTimeframe: Partial<Record<TokenTimeframe, MarketStructure>>;
  perp: PerpRead | null;
  sessionLevels: SessionLevel[];
  price: number;
  /** Whether the candles are real Binance data — the anticipatory read renders only on live data. */
  liveData: boolean;
  /** Unified POI ledger for the visible chart timeframe (display-only, EDR 0014). */
  poiMap: UnifiedPoi[];
  poiTimeframe: TokenTimeframe;
  /** Whether the plan is still valid at the live price (null when no plan). */
  setupValidity: SetupValidityResult | null;
  /** Controlled open sections of the evidence accordion (also driven by the tour). */
  evidenceOpen: string[];
  onEvidenceOpen: (open: string[]) => void;
  /** Opens the trade drawer (constitution-gated permit → confirm) + AI analyst, prefilled from this plan. */
  onOpenTrade: () => void;
  className?: string;
}) {
  const router = useRouter();
  const followSignal = useFollowSignal();
  const { follows } = useTrackedFollows();
  const hasOpenSignal = (
    sym: string,
    intent: DisplayIntentAssessment["intent"],
    direction: string,
  ) =>
    follows.some(
      (s) =>
        s.symbol === sym &&
        s.intent === intent &&
        s.direction === direction &&
        s.status === "active",
    );
  const marketType = usePreferencesStore((s) => s.marketType);
  const leverage = usePreferencesStore((s) => s.leverage);
  const setLeverage = usePreferencesStore((s) => s.setLeverage);
  const [followDialogOpen, setFollowDialogOpen] = useState(false);
  const [entryPriceInput, setEntryPriceInput] = useState("");

  const openFollowDialog = () => {
    if (!active?.plan) return;
    setEntryPriceInput(String(active.plan.entry));
    setFollowDialogOpen(true);
  };

  const confirmFollow = async () => {
    if (!active?.plan || active.direction === "none") return;
    // Safety re-check: the setup may have invalidated while the dialog was open.
    if (setupValidity && !setupValidity.valid) {
      toast.error(setupValidity.reason ?? "This setup is no longer valid.");
      setFollowDialogOpen(false);
      return;
    }
    const entryPrice = Number.parseFloat(entryPriceInput);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      toast.error("Enter a valid entry price.");
      return;
    }
    try {
      await followSignal.mutateAsync({
        symbol,
        intent: active.intent,
        direction: active.direction,
        setupType: active.execution.setupType,
        timeframe: active.definition.executionTimeframe,
        market: marketType,
        entryLow: active.plan.entryLow,
        entryHigh: active.plan.entryHigh,
        entryPrice,
        stop: active.plan.stop,
        target1: active.plan.target1,
        target2: active.plan.target2,
        confidenceAtFollow: active.confidence,
      });
    } catch (error) {
      if (error instanceof NotSignedInError) {
        toast.error("Sign in to follow signals — follows live in your server record now.", {
          action: { label: "Sign in", onClick: () => router.navigate({ to: "/login" }) },
        });
      } else {
        toast.error("Couldn't save the follow — check your connection and try again.");
      }
      return;
    }
    setFollowDialogOpen(false);
    toast(`Now tracking ${symbol}`, {
      description: `${active.definition.label} ${active.direction} signal added to the tracker at ${formatMoney(entryPrice)}.`,
      action: {
        label: "View",
        onClick: () => router.navigate({ to: "/tracker" }),
      },
    });
  };

  if (!active) {
    return (
      <IqCard padded={false} className={cn("flex min-h-0 flex-col p-0", className)}>
        <div className="space-y-3 p-3">
          <div className="h-40 animate-pulse rounded-lg bg-surface" />
          <div className="h-28 animate-pulse rounded-lg bg-surface" />
          <div className="h-28 animate-pulse rounded-lg bg-surface" />
        </div>
      </IqCard>
    );
  }

  const canTrade =
    (active.verdict === "favored" || active.verdict === "caution") && active.direction !== "none";
  const setupInvalid = !!setupValidity && !setupValidity.valid;

  return (
    <IqCard padded={false} className={cn("flex min-h-0 flex-col p-0", className)}>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {/* ACTION — the execution plan, visible (not collapsed) whenever the
            objective is payable. It is the action tied to the verdict above,
            never evidence, so it never hides behind a tab. */}
        <div data-tour="risk" className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <CardEyebrow>Execution Plan · {active.definition.executionTimeframe}</CardEyebrow>
              <InfoHint text="A complete plan for your objective, sized to your account: entry, stop, two targets, position size, and worst-case loss. Counter-trend verdicts are automatically halved. Change account size and risk in Settings." />
            </div>
            {active.plan && active.sizeMultiplier < 1 && (
              <Badge variant="outline" className="border-warning/30 bg-warning-soft text-warning">
                ½ size
              </Badge>
            )}
          </div>

          {active.plan ? (
            <>
              <div className="flex gap-1.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <PlanRow
                    color="#60a5fa"
                    label="Entry"
                    value={formatEntryRange(active.plan.entryLow, active.plan.entryHigh)}
                  />
                  <PlanRow
                    color="#f43f5e"
                    label="Stop loss"
                    value={formatMoney(active.plan.stop)}
                  />
                  <PlanRow
                    color="#22c55e"
                    label="Target 1"
                    value={formatMoney(active.plan.target1)}
                  />
                  <PlanRow
                    color="#22c55e"
                    label="Target 2"
                    value={formatMoney(active.plan.target2)}
                  />
                  <PlanRow
                    color="#94a3b8"
                    label="R / R"
                    value={`${active.plan.rewardRisk1}R / ${active.plan.rewardRisk2}R`}
                  />
                </div>
                <PlanLadder plan={active.plan} />
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <RiskMetric
                  label="Position"
                  value={`${formatUnits(active.plan.positionSize)} ≈ ${formatMoney(active.plan.positionSize * active.plan.entry)}`}
                  compact
                />
                <RiskMetric
                  label="Max loss"
                  value={formatMoney(active.plan.maxDollarLoss)}
                  tone="bearish"
                  compact
                />
                <RiskMetric
                  label="Gain @ T1"
                  value={formatMoney(active.plan.estimatedGain1)}
                  tone="bullish"
                  compact
                />
              </div>
              {marketType === "perp" && (
                <>
                  <PerpLeverage plan={active.plan} leverage={leverage} onLeverage={setLeverage} />
                  <LiquidationCheck plan={active.plan} leverage={leverage} />
                </>
              )}
              <SizingNote multiplier={active.sizeMultiplier} />
              {setupInvalid ? (
                <div className="flex w-full items-center gap-1.5 rounded-md border border-warning/30 bg-warning-soft px-2.5 py-2 text-xs text-warning">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                  <span>{setupValidity?.reason ?? "Setup no longer valid at current price."}</span>
                </div>
              ) : (
                canTrade && (
                  // The plan and the action are one unit: placing a trade is the
                  // primary path, prefilled straight from the plan above;
                  // "Follow" is the separate, secondary paper-tracking bookmark.
                  <div className="flex flex-col gap-1.5">
                    <Button
                      size="sm"
                      className="w-full gap-1.5 text-xs font-semibold"
                      onClick={onOpenTrade}
                    >
                      <Send className="h-3.5 w-3.5" />
                      Place Trade — Get Permit
                    </Button>
                    {hasOpenSignal(symbol, active.intent, active.direction) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled
                        className="w-full gap-1.5 text-xs"
                      >
                        <BookmarkCheck className="h-3.5 w-3.5" />
                        Following this signal
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full gap-1.5 text-xs"
                        onClick={openFollowDialog}
                      >
                        <Bookmark className="h-3.5 w-3.5" />
                        Follow this signal
                      </Button>
                    )}
                  </div>
                )
              )}
            </>
          ) : (
            <p className="rounded-lg border border-border bg-surface p-2.5 text-xs leading-relaxed text-muted-foreground">
              {planEmptyMessage(active, assessments)}
            </p>
          )}
        </div>

        {/* EVIDENCE — one level down, collapsed by default. Three groups, each
            citing the verdict line it supports (§4.4). */}
        <Accordion
          type="multiple"
          value={evidenceOpen}
          onValueChange={onEvidenceOpen}
          className="rounded-lg border border-border"
        >
          {/* WHY THIS VERDICT — the reads that produced the call. */}
          <AccordionItem value="why" className="border-b border-border last:border-b-0">
            <AccordionTrigger
              data-tour="insight"
              className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider"
            >
              Why this verdict
            </AccordionTrigger>
            <AccordionContent className="space-y-3 px-3">
              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Verdict · {active.definition.label}</CardEyebrow>
                  <InfoHint text="'Not yet', 'reduced size', 'wrong direction', and 'unsuitable market' are all different answers. The header names the one that applies; this text explains why in plain words." />
                </div>
                <MarketPhaseNote assessment={active} />
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {active.summary}
                </p>
                <HoldNote hold={active.hold} />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>
                    Checklist · {active.checklist.filter((item) => item.done).length}/
                    {active.checklist.length}
                  </CardEyebrow>
                  <InfoHint text="Everything this objective needs before a full-size entry. The unchecked items are what 'not yet' means, concretely. Hover an item for the detail." />
                </div>
                <div className="space-y-1">
                  {active.checklist.map((item) => (
                    <Tooltip key={item.label}>
                      <TooltipTrigger asChild>
                        <div className="flex cursor-default items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
                          {item.done ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-bullish" />
                          ) : (
                            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
                          )}
                          <span className="min-w-0 truncate text-[11px] font-semibold">
                            {item.label}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        className="max-w-[260px] bg-popover text-xs leading-relaxed text-popover-foreground shadow-lg"
                      >
                        {item.detail}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>What Changes This Answer</CardEyebrow>
                  <InfoHint text="Concrete price events that would upgrade, downgrade, or flip today's verdict — so you know what to watch for instead of re-reading the chart all day." />
                </div>
                <div className="space-y-1">
                  {active.triggers.map((trigger) => (
                    <div
                      key={trigger}
                      className="flex items-start gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
                    >
                      <Zap className="mt-0.5 h-3 w-3 shrink-0 text-info" />
                      <span>{trigger}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Market Read</CardEyebrow>
                  <InfoHint text="What the two timeframes behind your objective are doing. When they disagree it doesn't mean 'no trade' — it changes which objectives are payable and which should wait." />
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <BiasCell
                    label={`${active.definition.contextTimeframe} context`}
                    regime={active.context.regime}
                    bias={active.contextBias}
                  />
                  <BiasCell
                    label={`${active.definition.executionTimeframe} trigger`}
                    regime={active.execution.regime}
                    bias={active.executionBias}
                  />
                </div>
              </div>

              <StructureAlignmentCard
                structures={structuresByTimeframe}
                contextTimeframe={active.definition.contextTimeframe}
                executionTimeframe={active.definition.executionTimeframe}
              />

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Conditions · {active.definition.executionTimeframe}</CardEyebrow>
                  <InfoHint text="The market's current condition in plain words — trend, momentum, volume, volatility, and the swing structure (higher or lower highs and lows) the engine reads from the chart — with the exact ATR and volume readings below. Bigger ATR means wilder swings." />
                </div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {keyInsights(active.execution).map((row) => (
                    <KeyInsightBox key={row.label} {...row} />
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <LevelStat
                    label="ATR (14)"
                    value={
                      active.execution.analytics.atrPercent !== null
                        ? `${active.execution.analytics.atrPercent}%`
                        : "n/a"
                    }
                  />
                  <LevelStat
                    label="Vol vs 20-bar"
                    value={
                      active.execution.analytics.volumeRatio !== null
                        ? `${active.execution.analytics.volumeRatio}×`
                        : "n/a"
                    }
                  />
                </div>
              </div>

              {active.location && (
                <LocationRow
                  location={active.location}
                  support={active.execution.analytics.support}
                  resistance={active.execution.analytics.resistance}
                />
              )}

              {liveData && poiMap.length > 0 && (
                <PoiMapCard pois={poiMap} timeframe={poiTimeframe} />
              )}

              {sessionLevels.length > 0 && price > 0 && (
                <SessionLevelsCard levels={sessionLevels} price={price} />
              )}

              {liveData && active.anticipatoryPlan && (
                <AnticipatoryReadCard
                  plan={active.anticipatoryPlan}
                  timeframe={active.definition.executionTimeframe}
                />
              )}

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <CardEyebrow>Engine Checks · {active.definition.executionTimeframe}</CardEyebrow>
                  <InfoHint text="Every check the engine ran with its score contribution. Hover a check to read what it found. Green passed, amber is a caution, red failed." />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {active.execution.components.map((component) => (
                    <Tooltip key={component.name}>
                      <TooltipTrigger asChild>
                        <div className="flex cursor-default items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
                          <StatusIcon status={component.status} />
                          <span className="whitespace-nowrap text-[11px] font-semibold">
                            {component.name}
                          </span>
                          <StatusBadge status={component.status} score={component.score} />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        className="max-w-[260px] bg-popover text-xs leading-relaxed text-popover-foreground shadow-lg"
                      >
                        {component.explanation}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>

              {marketOutlook && (
                <div className="rounded-lg border border-border bg-surface p-2.5">
                  <div className="flex items-center gap-1.5">
                    <CardEyebrow>Market Outlook</CardEyebrow>
                    <InfoHint text="The current market story for this token, told before any recommendation: the big picture, the near-term tape, and what that combination rewards. Every verdict is this narrative applied to one objective." />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    {marketOutlook}
                  </p>
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* TRACK RECORD — the engine's forward-test record for this verdict. */}
          <AccordionItem value="record" className="border-b border-border last:border-b-0">
            <AccordionTrigger className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider">
              Track record
            </AccordionTrigger>
            <AccordionContent className="space-y-3 px-3">
              {active.record ? (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-lg border p-2.5 text-[11px] leading-relaxed",
                    active.record.demoted
                      ? "border-warning/30 bg-warning-soft text-warning"
                      : "border-border bg-surface text-muted-foreground",
                  )}
                >
                  <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <span className="text-[9px] font-semibold uppercase tracking-wider">
                      Engine's live record
                    </span>
                    <p className="mt-0.5">{active.record.note}</p>
                  </div>
                </div>
              ) : (
                <p className="rounded-lg border border-border bg-surface p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  No settled forward-test record for this setup × regime yet — the engine is still
                  gathering evidence at the current version.
                </p>
              )}

              <AnticipatoryRecordNote />
            </AccordionContent>
          </AccordionItem>

          {/* CONTEXT — events, funding caution, and positioning around the call. */}
          <AccordionItem value="context" className="border-b-0">
            <AccordionTrigger className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider">
              Context
            </AccordionTrigger>
            <AccordionContent className="space-y-3 px-3">
              <TokenEventsCard symbol={symbol} />
              {perp ? (
                <PerpContextCard perp={perp} />
              ) : (
                <p className="rounded-lg border border-border bg-surface p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  Perp positioning (funding, open interest) appears in perp mode.
                </p>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        {/* AI analyst — reachable, never primary. Opens the same drawer as the
            permit path, where the BYOK analyst narrates (never originates) the
            plan above. */}
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1.5 text-xs"
          onClick={onOpenTrade}
        >
          <Brain className="h-3.5 w-3.5" />
          Open AI analyst &amp; execution
        </Button>
      </div>

      <Dialog open={followDialogOpen} onOpenChange={setFollowDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Follow {symbol}</DialogTitle>
            <DialogDescription>
              {active &&
                `Confirm the price you actually entered at — the engine's ideal zone was ${formatEntryRange(active.plan?.entryLow ?? 0, active.plan?.entryHigh ?? 0)}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label
              htmlFor="follow-entry-price"
              className="text-xs font-medium text-muted-foreground"
            >
              Your entry price
            </label>
            <Input
              id="follow-entry-price"
              type="number"
              step="any"
              value={entryPriceInput}
              onChange={(e) => setEntryPriceInput(e.target.value)}
              autoFocus
            />
          </div>
          {active?.plan && (
            <div className="grid grid-cols-3 gap-1.5 text-xs">
              <RiskMetric
                label="Stop"
                value={formatMoney(active.plan.stop)}
                tone="bearish"
                compact
              />
              <RiskMetric
                label="Target 1"
                value={formatMoney(active.plan.target1)}
                tone="bullish"
                compact
              />
              <RiskMetric
                label="Target 2"
                value={formatMoney(active.plan.target2)}
                tone="bullish"
                compact
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFollowDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmFollow}>Confirm and track</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </IqCard>
  );
}
