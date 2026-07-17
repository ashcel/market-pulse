import type { MarketStructure, SwingPoint } from "./structure";

/**
 * Strong vs. weak swings — the SMC read behind objective selection. A swing
 * high whose decline broke structure (its own pullback leg took out the swing
 * low that preceded it) is *strong*: the market defended it, and it protects
 * the range above. A swing high whose decline failed to break that low is
 * *weak*: the push down from it had no force, so the liquidity resting above
 * it is the draw — it is a target. Mirror for lows. This is the classifier
 * behind "objective = weak structure" in the Dreimann framework.
 *
 * Strength is inherently forward-looking: a swing's type is a function of how
 * much history you have seen, so it can never be a stored `SwingPoint` field
 * without breaking the structure engine's frozen-record invariant. This module
 * therefore only *derives* a view over a computed `MarketStructure` at read
 * time — the same pattern `liquidity.ts` uses for `intact` — and adds no state
 * of its own. Pass a structure built from a bar-limited window and you get
 * exactly what was knowable then, which is what makes the view replay-safe.
 * See docs/decisions/0004-swing-strength-derived-view.md.
 */

export type SwingStrength = "strong" | "weak" | "unresolved";

export interface SwingStrengthEntry {
  /** The same object held in `structure.swings` — join by identity. */
  swing: SwingPoint;
  strength: SwingStrength;
  /**
   * The swing's own counter-leg — the opposite-kind swing right after it,
   * whose verdict this is: for strong it is the breaker, for weak it is the
   * completed leg that failed. Null while no counter-leg exists. While the
   * counter-leg is the series' still-forming final leg, its extreme (and so
   * this reference) can still be replaced by a more extreme pivot of the same
   * leg — a *strong* verdict it already delivered can never change (see the
   * EDR for why weak waits for the leg to complete).
   */
  judgedBy: SwingPoint | null;
}

/**
 * Derive the strength of every swing in the structure, in `swings` order.
 *
 * The verdict is scoped to the swing's own counter-leg (alternation makes
 * that `swings[i + 1]`, and the preceding opposite swing `swings[i - 1]`):
 *
 * - **strong** the moment the counter-leg trades strictly beyond the
 *   preceding opposite swing — for a high, its pullback low broke the prior
 *   swing low, making the high the origin of a downward break of structure.
 *   Decidable while the leg is still forming: a forming leg only ever grows
 *   more extreme, so a break cannot un-happen.
 * - **weak** once the counter-leg *completes* without that break (completion
 *   = the next same-kind swing, `swings[i + 2]`, exists, freezing the leg's
 *   extreme). A failed leg cannot retroactively succeed, so this too is
 *   final. A later break by some other leg does not rescue the swing — that
 *   break has its own origin.
 * - **unresolved** while the counter-leg is absent or still forming without a
 *   break — the swing is still targetable but unproven, exactly the state an
 *   objective is drawn from.
 *
 * Strict inequalities throughout, consistent with the HH/LL label rule in
 * `structure.ts`: a retest that merely matches the prior opposite extreme is
 * no break. The first swing of the series has no preceding opposite swing to
 * measure a break against, so it stays permanently unresolved rather than
 * faking a verdict.
 */
export function deriveSwingStrength(structure: MarketStructure): SwingStrengthEntry[] {
  const swings = structure.swings;
  return swings.map((swing, index) => {
    const prior = index > 0 ? swings[index - 1] : null;
    const counterLeg = index + 1 < swings.length ? swings[index + 1] : null;
    if (!prior || !counterLeg) return { swing, strength: "unresolved" as const, judgedBy: null };

    const broke =
      swing.kind === "high" ? counterLeg.price < prior.price : counterLeg.price > prior.price;
    if (broke) return { swing, strength: "strong" as const, judgedBy: counterLeg };

    const legCompleted = index + 2 < swings.length;
    return legCompleted
      ? { swing, strength: "weak" as const, judgedBy: counterLeg }
      : { swing, strength: "unresolved" as const, judgedBy: null };
  });
}
