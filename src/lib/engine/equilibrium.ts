import { deriveSwingStrength } from "./strength";
import type { MarketStructure, SwingPoint } from "./structure";

/**
 * Dealing range and equilibrium — the premium/discount read. The range runs
 * from the most recent *strong* swing (the last level the market actually
 * defended — see `strength.ts`) to the most extreme opposite swing printed
 * since it: the leg the market is currently dealing in. Its midpoint is
 * equilibrium; above it price is at a premium, below it at a discount. The
 * SMC entry gate this exists for: longs are bought at a discount of the
 * current range, shorts sold at a premium ("long only in discount").
 *
 * Like `strength.ts`, this is a derived view over a computed structure with
 * no state of its own — bar-limited window in, what-was-knowable-then out.
 * A range may simply not exist yet (no strong swing, or nothing printed
 * beyond it); absence is a first-class outcome consumers must handle, never
 * fabricated from unproven swings.
 * See docs/decisions/0005-dealing-range-equilibrium.md.
 */

export interface DealingRange {
  /** The range floor. When `anchor` is "low", this is the strong swing itself. */
  low: SwingPoint;
  /** The range ceiling. When `anchor` is "high", this is the strong swing itself. */
  high: SwingPoint;
  /** Which side is the defended (strong) swing the range is anchored to. */
  anchor: "low" | "high";
  /** The midpoint of the range — the premium/discount boundary. */
  equilibrium: number;
}

export type PricePosition = "premium" | "discount" | "equilibrium";

/**
 * Derive the active dealing range: anchor at the most recent strong swing,
 * then take the most extreme opposite-kind swing that printed after it (the
 * farthest the market has dealt away from the defended level). Null when no
 * swing is strong yet or nothing has printed beyond the anchor.
 *
 * Anchoring at the latest strong swing of *either* kind — rather than pairing
 * the last strong low with the last strong high — is deliberate: in a trend
 * the two can invert (an old strong high below the latest strong low), which
 * yields a nonsense range, while the anchored form reproduces the ranges the
 * ground-truth charts were actually drawn over (see the EDR).
 */
export function computeDealingRange(structure: MarketStructure): DealingRange | null {
  const entries = deriveSwingStrength(structure);
  let anchorIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].strength === "strong") {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex === -1) return null;

  const anchor = structure.swings[anchorIndex];
  let extreme: SwingPoint | null = null;
  for (const swing of structure.swings.slice(anchorIndex + 1)) {
    if (swing.kind === anchor.kind) continue;
    // Strict comparison keeps the earlier swing on a tie — deterministic.
    if (
      !extreme ||
      (anchor.kind === "low" ? swing.price > extreme.price : swing.price < extreme.price)
    ) {
      extreme = swing;
    }
  }
  if (!extreme) return null;

  const low = anchor.kind === "low" ? anchor : extreme;
  const high = anchor.kind === "low" ? extreme : anchor;
  if (low.price >= high.price) return null;

  return { low, high, anchor: anchor.kind, equilibrium: (low.price + high.price) / 2 };
}

/**
 * Where a price sits in the range. Exact midpoint reads "equilibrium"; there
 * is deliberately no tolerance band — a band is a tunable threshold, and this
 * layer ships none (Phase 0 instrumentation; see the EDR).
 */
export function classifyPrice(range: DealingRange, price: number): PricePosition {
  if (price > range.equilibrium) return "premium";
  if (price < range.equilibrium) return "discount";
  return "equilibrium";
}
