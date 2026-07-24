import { useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { cn } from "@/lib/utils";

/** The three draggable plan levels. Entry drives sizing, stop is mandatory,
 *  target is optional (drives R:R). Colors mirror the chart plan lines. */
type LevelKey = "entry" | "stop" | "target";

export interface PlanDraft {
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number | null;
}

const LEVEL_META: Record<LevelKey, { label: string; color: string; ring: string }> = {
  entry: { label: "Entry", color: "#60a5fa", ring: "ring-[#60a5fa]" },
  stop: { label: "Stop", color: "#f43f5e", ring: "ring-[#f43f5e]" },
  target: { label: "Target", color: "#22c55e", ring: "ring-[#22c55e]" },
};

/** Round a price to a sensible number of digits for its magnitude — the exact
 *  value is re-derived by the deterministic sizing/permit path, this is only
 *  what the handle snaps to as the user drags. */
function roundForMagnitude(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 1000) return Math.round(price * 10) / 10;
  if (abs >= 10) return Math.round(price * 100) / 100;
  if (abs >= 1) return Math.round(price * 1000) / 1000;
  return Number(price.toPrecision(5));
}

function fmt(price: number): string {
  const abs = Math.abs(price);
  if (abs >= 1000) return price.toFixed(1);
  if (abs >= 10) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(3);
  return price.toPrecision(5);
}

interface ChartPlanEditorProps {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  /** The relative container the handles are positioned within (chart host's
   *  parent) — used to convert pointer clientY into pane coordinates. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  draft: PlanDraft | null;
  onChange: (next: PlanDraft) => void;
}

/**
 * Draggable entry/stop/target levels laid over the chart. Follows the proven
 * coordinate-sync pattern in `TradeActionOverlay` (priceToCoordinate + rAF loop
 * + visible-range subscriptions) so handles track pan/zoom/autoscale. Dragging
 * a handle converts pointer-Y back to a price and pushes the new plan up; the
 * ticket + permit (fed from this draft) recompute. It never sets a quantity —
 * it only moves the price levels the deterministic sizing path reads.
 */
export function ChartPlanEditor({
  chart,
  series,
  containerRef,
  enabled,
  draft,
  onChange,
}: ChartPlanEditorProps) {
  const handleRefs = useRef<Record<LevelKey, HTMLDivElement | null>>({
    entry: null,
    stop: null,
    target: null,
  });
  // Live mirror of the draft prices so the rAF loop and pointer math read the
  // latest without re-subscribing every drag frame.
  const draftRef = useRef<PlanDraft | null>(draft);
  draftRef.current = draft;
  const draggingRef = useRef<LevelKey | null>(null);
  // Set by the drag effect once listeners are wired; called from handle press.
  const startDragRef = useRef<(key: LevelKey) => void>(() => {});

  // Position the handles every frame while enabled (mirrors TradeActionOverlay).
  useEffect(() => {
    if (!enabled || !chart || !series) return;

    let reqId = 0;
    const place = () => {
      const d = draftRef.current;
      if (d) {
        (["entry", "stop", "target"] as LevelKey[]).forEach((key) => {
          const el = handleRefs.current[key];
          if (!el) return;
          const price = key === "target" ? d.target : d[key];
          if (price === null || !Number.isFinite(price)) {
            el.style.display = "none";
            return;
          }
          const y = series.priceToCoordinate(price);
          if (y === null) {
            el.style.display = "none";
          } else {
            el.style.display = "";
            el.style.top = `${y}px`;
          }
        });
      }
      reqId = requestAnimationFrame(place);
    };
    reqId = requestAnimationFrame(place);
    return () => cancelAnimationFrame(reqId);
  }, [enabled, chart, series]);

  // Pointer drag: convert clientY -> pane Y -> price, push up.
  useEffect(() => {
    if (!enabled || !chart || !series) return;

    const onMove = (e: PointerEvent) => {
      const key = draggingRef.current;
      const container = containerRef.current;
      const d = draftRef.current;
      if (!key || !container || !d) return;
      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const raw = series.coordinateToPrice(y);
      if (raw === null) return;
      const price = roundForMagnitude(raw as number);
      if (!(price > 0)) return;
      const next: PlanDraft = key === "target" ? { ...d, target: price } : { ...d, [key]: price };
      onChange(next);
    };
    const onUp = () => {
      if (draggingRef.current === null) return;
      draggingRef.current = null;
      // Re-enable chart pan/zoom after a drag.
      chart.applyOptions({
        handleScroll: true,
        handleScale: true,
      });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // Store for handle mousedown to attach.
    startDragRef.current = (key: LevelKey) => {
      draggingRef.current = key;
      chart.applyOptions({ handleScroll: false, handleScale: false });
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [enabled, chart, series, containerRef, onChange]);

  if (!enabled || !draft) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {(["target", "entry", "stop"] as LevelKey[]).map((key) => {
        const meta = LEVEL_META[key];
        const price = key === "target" ? draft.target : draft[key];
        if (price === null) return null;
        return (
          <div
            key={key}
            ref={(el) => {
              handleRefs.current[key] = el;
            }}
            className="absolute left-0 right-0"
            style={{ top: 0, transform: "translateY(-50%)" }}
          >
            <div className="flex items-center" style={{ height: 0 }}>
              <div
                className="h-px flex-1 opacity-70"
                style={{
                  background: `repeating-linear-gradient(to right, ${meta.color} 0 6px, transparent 6px 10px)`,
                }}
              />
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  startDragRef.current(key);
                }}
                className={cn(
                  "pointer-events-auto flex cursor-ns-resize touch-none items-center gap-1 rounded px-2 py-0.5 text-[11px] font-bold text-white shadow ring-1",
                  meta.ring,
                )}
                style={{ background: meta.color }}
                aria-label={`Drag ${meta.label} level`}
              >
                <span className="opacity-90">{meta.label}</span>
                <span className="num">{fmt(price)}</span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
