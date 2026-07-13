import { useState } from "react";

import { CardEyebrow } from "@/components/iq/iq-card";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { PoiSource, UnifiedPoi } from "@/lib/engine/poi-map";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The unified POI ledger for the visible timeframe: base zones, order blocks,
 * and FVGs side by side, each with its state and premium/discount position.
 * Display only (EDR 0014) — the anticipatory plan still selects from base
 * zones alone, so agreement or disagreement between detectors is context, not
 * a signal. Callers render it only on live data, like the anticipatory card.
 */

const SOURCE_BADGE: Record<PoiSource, string> = {
  "base-zone": "Zone",
  "order-block": "OB",
  fvg: "FVG",
  ifvg: "iFVG",
};

const STATE_TONE: Record<UnifiedPoi["state"], string> = {
  fresh: "text-success",
  tested: "text-warning",
  mitigated: "text-warning",
  invalidated: "text-muted-foreground line-through",
  consumed: "text-muted-foreground line-through",
};

function PoiRow({ poi }: { poi: UnifiedPoi }) {
  return (
    <div className="flex items-center gap-2 text-[11px] leading-relaxed">
      <span className="w-10 shrink-0 rounded border border-border bg-card px-1 text-center text-[9px] font-semibold uppercase text-muted-foreground">
        {SOURCE_BADGE[poi.source]}
      </span>
      <span className="num min-w-0 flex-1 truncate">
        {formatMoney(poi.priceLow)}–{formatMoney(poi.priceHigh)}
      </span>
      {poi.sizeAtr !== null && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {poi.sizeAtr.toFixed(1)}×ATR
        </span>
      )}
      {poi.position && (
        <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{poi.position}</span>
      )}
      <span className={cn("shrink-0 text-[10px] font-semibold uppercase", STATE_TONE[poi.state])}>
        {poi.state}
      </span>
    </div>
  );
}

/** Rows shown per side before the ledger collapses behind "show all". */
const COLLAPSED_ROWS = 3;

export function PoiMapCard({ pois, timeframe }: { pois: UnifiedPoi[]; timeframe: TokenTimeframe }) {
  // The full ledger can run long (three detectors × both sides, terminal
  // rows included) — on a phone that pushes the S/R and session cards off
  // screen, so each side collapses to its nearest few rows.
  const [expanded, setExpanded] = useState(false);
  if (pois.length === 0) return null;
  // Nearest-to-price groups read top-down like the chart: supply descends
  // toward price, demand ascends away from it.
  const demand = pois.filter((p) => p.kind === "demand").sort((a, b) => b.priceHigh - a.priceHigh);
  const supply = pois.filter((p) => p.kind === "supply").sort((a, b) => a.priceLow - b.priceLow);
  const hiddenCount = expanded
    ? 0
    : Math.max(0, demand.length - COLLAPSED_ROWS) + Math.max(0, supply.length - COLLAPSED_ROWS);
  const visible = (rows: UnifiedPoi[]) => (expanded ? rows : rows.slice(0, COLLAPSED_ROWS));

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <CardEyebrow>Points of Interest · {timeframe}</CardEyebrow>
      <div className="mt-1.5 space-y-2">
        {supply.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase text-warning">Supply above</div>
            {visible(supply).map((poi) => (
              <PoiRow key={`${poi.source}-${poi.startTime}-${poi.priceLow}`} poi={poi} />
            ))}
          </div>
        )}
        {demand.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase text-success">Demand below</div>
            {visible(demand).map((poi) => (
              <PoiRow key={`${poi.source}-${poi.startTime}-${poi.priceLow}`} poi={poi} />
            ))}
          </div>
        )}
      </div>
      {(hiddenCount > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 w-full rounded-md border border-border bg-card py-1 text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show fewer" : `Show all (${hiddenCount} more)`}
        </button>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        Display only — the anticipatory plan still selects from base zones (EDR 0009). OB and FVG
        reads agreeing with a zone is confluence context, not a signal.
      </p>
    </div>
  );
}
