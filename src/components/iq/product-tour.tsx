import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface TourStep {
  /** Matches a `data-tour` attribute on the page. */
  target: string;
  title: string;
  body: string;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const CARD_WIDTH = 330;
const CARD_GAP = 12;

/**
 * Dependency-free spotlight tour: dims the page, cuts a hole over the
 * current step's `data-tour` element, and anchors an explainer card next
 * to it. Parent owns open state; `onStepChange` fires before measuring so
 * the page can prepare (e.g. expand a collapsed drawer).
 */
export function ProductTour({
  steps,
  open,
  onClose,
  onStepChange,
}: {
  steps: TourStep[];
  open: boolean;
  onClose: () => void;
  onStepChange?: (target: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const step = steps[index];

  const measure = useCallback(() => {
    if (!step) return;
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
  }, [step]);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open || !step) return;
    onStepChange?.(step.target);
    // Let the page react (drawer expansion, scroll) before measuring.
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const timer = setTimeout(measure, 120);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, step, measure, onStepChange]);

  if (!open || !step) return null;

  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
  const below = rect ? rect.top + rect.height + CARD_GAP : viewportH / 2 - 90;
  const placeBelow = rect ? below + 220 < viewportH || rect.top < 240 : true;
  const cardTop = rect ? (placeBelow ? below : undefined) : viewportH / 2 - 90;
  const cardBottom = rect && !placeBelow ? viewportH - rect.top + CARD_GAP : undefined;
  const cardLeft = Math.min(
    Math.max(12, rect ? rect.left : viewportW / 2 - CARD_WIDTH / 2),
    viewportW - CARD_WIDTH - 12,
  );

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-label="Product tour">
      {rect ? (
        // The spotlight: transparent hole over the target, dimming everything else.
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-info transition-all duration-200"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            boxShadow: "0 0 0 9999px rgba(4,6,10,0.72)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[rgba(4,6,10,0.72)]" />
      )}

      <div
        className="absolute flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 shadow-2xl"
        style={{ top: cardTop, bottom: cardBottom, left: cardLeft, width: CARD_WIDTH }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-info">
            Step {index + 1} of {steps.length}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tour"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="text-sm font-semibold">{step.title}</div>
        <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Skip tour
          </button>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn("h-7", index === 0 && "invisible")}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7"
              onClick={() => (index === steps.length - 1 ? onClose() : setIndex((i) => i + 1))}
            >
              {index === steps.length - 1 ? "Finish" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
