import { ClipboardCheck } from "lucide-react";

import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { INTENTS, type TradingIntent } from "@/lib/engine/intent";
import { cn } from "@/lib/utils";
import { InfoHint, humanSetup } from "@/components/features/token/shared";
import { CatalystLine } from "@/components/features/token/catalyst-line";
import {
  DecisionBanner,
  MarketPhaseBadge,
  ReadStrengthGauge,
  VerdictDot,
  VerdictHero,
  verdictTone,
} from "@/components/features/token/verdict-cards";

/**
 * Layer 1 of the verdict-first token page (IA redesign §4.4): the page's
 * answer, always visible and never scrolled away behind a tab. Per-objective
 * verdict chips with the active objective expanded (verdict word, the setup,
 * the not-yet / what-flips-it one-liner), the catalyst line that amends the
 * call, and the Check entry point. All evidence lives one level down in the
 * collapsed accordion; nothing here requires opening a tab.
 */
export function VerdictHeader({
  symbol,
  assessments,
  active,
  activeIntent,
  onSelect,
  onCheckTrade,
}: {
  symbol: string;
  assessments: DisplayIntentAssessment[];
  active: DisplayIntentAssessment | null;
  activeIntent: TradingIntent;
  onSelect: (intent: TradingIntent) => void;
  /** Enters Plan-on-chart mode (drag entry/stop/target -> permit). Disabled
   *  when the active objective has no tradeable plan. */
  onCheckTrade?: () => void;
}) {
  const byIntent = new Map(assessments.map((a) => [a.intent, a]));

  return (
    <IqCard padded={false} className="shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-2.5">
        <div className="flex items-center gap-1.5">
          <CardEyebrow>Verdict</CardEyebrow>
          <InfoHint text="One chart, many valid answers. Pick your objective and the assistant tells you whether this market pays it right now, what confirmation is still missing, and which price events would change today's answer — all without opening a tab." />
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          <div
            data-tour="objective"
            className="grid grid-cols-4 rounded-md border border-border bg-surface p-0.5 text-xs"
          >
            {INTENTS.map((def) => {
              const a = byIntent.get(def.intent);
              return (
                <button
                  key={def.intent}
                  type="button"
                  onClick={() => onSelect(def.intent)}
                  title={a?.headline ?? `${def.label}: assessing…`}
                  className={cn(
                    "flex h-9 flex-col items-center justify-center gap-1 rounded px-2.5 font-semibold transition-colors",
                    activeIntent === def.intent
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <VerdictDot assessment={a} />
                  {def.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onCheckTrade}
            disabled={!onCheckTrade || !active || active.direction === "none"}
            title={
              active && active.direction !== "none"
                ? "Drag entry/stop/target on the chart to size and check this trade"
                : "No tradeable plan for this objective yet"
            }
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-info px-3 text-xs font-semibold text-background transition-colors hover:bg-info/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            Check this trade
          </button>
        </div>
      </div>

      {!active ? (
        <div className="p-3">
          <div className="h-16 animate-pulse rounded-lg bg-surface" />
        </div>
      ) : (
        <div className="space-y-2.5 p-3">
          <div
            data-tour="decision"
            className={cn(
              "flex items-center justify-between gap-3 rounded-lg border p-3",
              verdictTone(active),
            )}
          >
            <div className="min-w-0">
              <VerdictHero assessment={active} />
              <p className="mt-1.5 truncate text-xs font-semibold text-foreground">
                {active.direction !== "none"
                  ? humanSetup(active.execution.setupType)
                  : active.headline}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {`${active.definition.contextTimeframe} context · ${active.definition.executionTimeframe} trigger · holds ${active.definition.horizon}`}
              </p>
              <MarketPhaseBadge assessment={active} />
            </div>
            <ReadStrengthGauge assessment={active} />
          </div>

          <DecisionBanner active={active} assessments={assessments} />

          <CatalystLine symbol={symbol} activeIntentLabel={active.definition.label} />
        </div>
      )}
    </IqCard>
  );
}
