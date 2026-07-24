import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts";
import { TrendingUp, Minus, Square, Ruler, MousePointer2, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useDrawingsStore,
  type Drawing,
  type DrawingTool,
  type DrawAnchor,
} from "@/stores/drawings";

type Tool = DrawingTool | "cursor";

const TOOL_META: { tool: Tool; label: string; icon: React.ElementType }[] = [
  { tool: "cursor", label: "Move", icon: MousePointer2 },
  { tool: "trendline", label: "Trendline", icon: TrendingUp },
  { tool: "hline", label: "Level", icon: Minus },
  { tool: "box", label: "Box", icon: Square },
  { tool: "fib", label: "Fib", icon: Ruler },
];

const TOOL_COLOR: Record<DrawingTool, string> = {
  trendline: "#eab308",
  hline: "#38bdf8",
  box: "#a78bfa",
  fib: "#22d3ee",
};

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

const EMPTY: Drawing[] = [];

interface ChartDrawingsProps {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  symbol: string;
  enabled: boolean;
}

/**
 * Freehand chart drawings (trendline / horizontal level / box / fib) laid over
 * the price pane as an SVG overlay. Anchors are stored in (logical index, price)
 * space and re-projected to pixels every frame, so they track pan/zoom/resize.
 * Additive and gated behind the "Draw" toggle — it never touches the chart data
 * pipeline (only pauses pan while a creation tool is active) and never feeds the
 * engine/verdict/permit. Persisted per symbol in localStorage.
 */
export function ChartDrawings({
  chart,
  series,
  containerRef,
  symbol,
  enabled,
}: ChartDrawingsProps) {
  const drawings = useDrawingsStore((s) => s.bySymbol[symbol] ?? EMPTY);
  const add = useDrawingsStore((s) => s.add);
  const remove = useDrawingsStore((s) => s.remove);
  const clear = useDrawingsStore((s) => s.clear);

  const [tool, setTool] = useState<Tool>("cursor");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Drawing | null>(null);
  // Bumped each frame so the SVG re-projects against the live time/price scale.
  const [, setTick] = useState(0);
  const draftRef = useRef<Drawing | null>(null);
  draftRef.current = draft;

  // Re-project loop while drawing mode is on.
  useEffect(() => {
    if (!enabled || !chart || !series) return;
    let id = requestAnimationFrame(function loop() {
      setTick((t) => (t + 1) % 1_000_000);
      id = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, [enabled, chart, series]);

  // Pause chart pan/zoom only while a creation tool is armed.
  useEffect(() => {
    if (!chart) return;
    const drawingMode = enabled && tool !== "cursor";
    chart.applyOptions({ handleScroll: !drawingMode, handleScale: !drawingMode });
    return () => {
      chart.applyOptions({ handleScroll: true, handleScale: true });
    };
  }, [chart, enabled, tool]);

  if (!enabled || !chart || !series) return null;

  const ts = chart.timeScale();
  const paneWidth = ts.width();
  const toX = (logical: number): number | null => ts.logicalToCoordinate(logical as Logical);
  const toY = (price: number): number | null => series.priceToCoordinate(price);

  const anchorFromEvent = (e: React.PointerEvent): DrawAnchor | null => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const logical = ts.coordinateToLogical(x);
    const price = series.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    return { logical: logical as number, price: price as number };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool === "cursor") return;
    const anchor = anchorFromEvent(e);
    if (!anchor) return;
    e.preventDefault();
    const color = TOOL_COLOR[tool];
    if (tool === "hline") {
      add(symbol, { id: crypto.randomUUID(), tool, a: anchor, b: anchor, color });
      setTool("cursor");
      return;
    }
    setDraft({ id: "draft", tool, a: anchor, b: anchor, color });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draftRef.current) return;
    const anchor = anchorFromEvent(e);
    if (!anchor) return;
    setDraft((d) => (d ? { ...d, b: anchor } : d));
  };

  const onPointerUp = () => {
    const d = draftRef.current;
    if (!d) return;
    add(symbol, { ...d, id: crypto.randomUUID() });
    setDraft(null);
    setTool("cursor");
  };

  const armed = tool !== "cursor";
  const renderList = draft ? [...drawings, draft] : drawings;

  return (
    <>
      {/* Toolbar */}
      <div className="pointer-events-auto absolute left-2 top-2 z-20 flex items-center gap-1 rounded-md border border-border bg-card/95 p-1 shadow-sm backdrop-blur">
        {TOOL_META.map((t) => (
          <button
            key={t.tool}
            type="button"
            onClick={() => {
              setTool(t.tool);
              setSelectedId(null);
            }}
            title={t.label}
            aria-pressed={tool === t.tool}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded transition-colors",
              tool === t.tool
                ? "bg-info-soft text-info"
                : "text-muted-foreground hover:bg-surface hover:text-foreground",
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
          </button>
        ))}
        <div className="mx-0.5 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => selectedId && (remove(symbol, selectedId), setSelectedId(null))}
          disabled={!selectedId}
          title="Delete selected"
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface hover:text-bearish disabled:opacity-30"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            clear(symbol);
            setSelectedId(null);
          }}
          disabled={drawings.length === 0}
          title="Clear all"
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface hover:text-bearish disabled:opacity-30"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* SVG overlay. Root captures pointers only when a creation tool is armed;
          in cursor mode individual hit shapes stay clickable for selection so
          chart pan still works in the gaps. */}
      <svg
        className={cn(
          "absolute inset-0 z-[16]",
          armed ? "pointer-events-auto" : "pointer-events-none",
        )}
        style={{ cursor: armed ? "crosshair" : "default" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {renderList.map((d) => (
          <DrawingShape
            key={d.id}
            drawing={d}
            toX={toX}
            toY={toY}
            paneWidth={paneWidth}
            selected={d.id === selectedId}
            onSelect={() => tool === "cursor" && setSelectedId(d.id)}
          />
        ))}
      </svg>
    </>
  );
}

function DrawingShape({
  drawing: d,
  toX,
  toY,
  paneWidth,
  selected,
  onSelect,
}: {
  drawing: Drawing;
  toX: (logical: number) => number | null;
  toY: (price: number) => number | null;
  paneWidth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const ax = toX(d.a.logical);
  const ay = toY(d.a.price);
  const bx = toX(d.b.logical);
  const by = toY(d.b.price);
  const width = selected ? 2.5 : 1.5;

  if (d.tool === "hline") {
    if (ay === null) return null;
    return (
      <g onPointerDown={onSelect}>
        <line x1={0} y1={ay} x2={paneWidth} y2={ay} stroke={d.color} strokeWidth={width} />
        <line
          x1={0}
          y1={ay}
          x2={paneWidth}
          y2={ay}
          stroke="transparent"
          strokeWidth={10}
          className="pointer-events-auto cursor-pointer"
        />
      </g>
    );
  }

  if (ax === null || ay === null || bx === null || by === null) return null;

  if (d.tool === "trendline") {
    return (
      <g onPointerDown={onSelect}>
        <line x1={ax} y1={ay} x2={bx} y2={by} stroke={d.color} strokeWidth={width} />
        <line
          x1={ax}
          y1={ay}
          x2={bx}
          y2={by}
          stroke="transparent"
          strokeWidth={10}
          className="pointer-events-auto cursor-pointer"
        />
      </g>
    );
  }

  if (d.tool === "box") {
    const x = Math.min(ax, bx);
    const y = Math.min(ay, by);
    const w = Math.abs(bx - ax);
    const h = Math.abs(by - ay);
    return (
      <g onPointerDown={onSelect} className="pointer-events-auto cursor-pointer">
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill={`${d.color}22`}
          stroke={d.color}
          strokeWidth={width}
        />
      </g>
    );
  }

  // fib
  const x1 = Math.min(ax, bx);
  const x2 = Math.max(ax, bx);
  return (
    <g onPointerDown={onSelect} className="pointer-events-auto cursor-pointer">
      {FIB_RATIOS.map((r) => {
        const price = d.a.price + (d.b.price - d.a.price) * r;
        const y = toY(price);
        if (y === null) return null;
        return (
          <g key={r}>
            <line
              x1={x1}
              y1={y}
              x2={x2}
              y2={y}
              stroke={d.color}
              strokeWidth={width}
              strokeOpacity={0.8}
            />
            <text x={x2 + 4} y={y + 3} fontSize={9} fill={d.color}>
              {r.toFixed(3)}
            </text>
          </g>
        );
      })}
    </g>
  );
}
