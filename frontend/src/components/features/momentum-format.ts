import type { RadarEvent } from "@/hooks/useMomentumRadar";

/** Formatting shared by the radar card and the event timeline. Kept out of
 * the component files so both can import it without breaking fast refresh. */

export function formatVolume(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${Math.round(value / 1e3)}K`;
  return `$${Math.round(value)}`;
}

export function formatPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function formatMult(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}×`;
}

export function directionClass(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-bullish" : "text-bearish";
}

/** Seconds-resolution freshness. The caller owns the clock, so one page-level
 * ticker drives every card rather than one interval each. */
export function ago(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** Prices span many orders of magnitude across the perp universe, so
 * significant digits beat a fixed decimal count. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return value.toFixed(1);
  if (value >= 1) return value.toFixed(3);
  return value.toPrecision(4);
}

/** An event's own reading, in its own unit. */
export function eventMagnitude(event: RadarEvent): string {
  if (event.unit === "x") return formatMult(event.magnitude);
  if (event.unit === "%") return formatPct(event.magnitude);
  if (event.unit === "1m") return "1m";
  return "";
}
