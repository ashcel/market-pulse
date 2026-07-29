import { IqCard } from "@/components/features/iq-card";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { INTENTS, type TradingIntent } from "@/lib/engine/intent";
import { cn } from "@/lib/utils";
import { VerdictDot } from "@/components/features/token/verdict-cards";

/**
 * Layer 1 of the verdict-first token page (IA redesign §4.4): the page's
 * answer, always visible and never scrolled away behind a tab. Per-objective
 * verdict chips with the active objective expanded (verdict word, the setup,
 * the not-yet / what-flips-it one-liner), the catalyst line that amends the
 * call, and the Check entry point. All evidence lives one level down in the
 * collapsed accordion; nothing here requires opening a tab.
 */
export function VerdictHeader({
  assessments,
  active,
  activeIntent,
  onSelect,
}: {
  symbol: string;
  assessments: DisplayIntentAssessment[];
  active: DisplayIntentAssessment | null;
  activeIntent: TradingIntent;
  onSelect: (intent: TradingIntent) => void;
}) {
  const byIntent = new Map(assessments.map((a) => [a.intent, a]));

  return (
    <IqCard padded={false} className="shrink-0">
      <div
        data-tour="decision"
        className="flex items-center gap-2 overflow-x-auto px-2 py-1.5 sm:px-3 sm:py-2"
      >
        <div className="flex min-w-max flex-1 items-center gap-2">
          <div
            data-tour="objective"
            className="grid grid-cols-4 rounded-md border border-border bg-surface p-0.5 text-[10px]"
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
                    "flex min-h-11 items-center justify-center gap-1.5 rounded px-2 font-semibold transition-colors sm:min-h-7",
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
        </div>
      </div>
    </IqCard>
  );
}
