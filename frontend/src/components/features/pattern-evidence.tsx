import { cn } from "@/lib/utils";

/** Mirrors one entry of `app.patterns.schemas.ReaccumulationReadResponse.evidence`. */
export interface PatternEvidenceItem {
  score: number;
  detail: string;
}

/** Fixed display order of the REACCUMULATION detector's six evidence components. */
export const PATTERN_EVIDENCE_ORDER = [
  "previousImpulse",
  "retracementQuality",
  "baseQuality",
  "oiReset",
  "oiRebuild",
  "currentExpansion",
] as const;

/**
 * One evidence-component row — label, 0-100% score, progress bar, and the
 * detector's own one-line detail. Shared by every REACCUMULATION surface
 * (token-page card + discover screening card) so the read stays visually
 * identical wherever it's shown. Takes an already-translated `label`; this
 * component owns no i18n keys of its own.
 */
export function PatternEvidenceRow({
  label,
  item,
}: {
  label: string;
  item: PatternEvidenceItem;
}) {
  const pct = Math.round(item.score * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="num font-semibold text-foreground">{pct}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className={cn("h-full rounded-full", pct >= 60 ? "bg-bullish" : "bg-muted-foreground/50")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">{item.detail}</p>
    </div>
  );
}
