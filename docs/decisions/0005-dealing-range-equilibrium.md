# EDR 0005: Dealing range anchored at the last strong swing; equilibrium splits it exactly

- **Status:** Accepted, implemented (2026-07-10)
- **Scope:** `computeDealingRange` / `classifyPrice` in `src/lib/engine/equilibrium.ts`. Phase 0 instrumentation: no verdict, score, or keyspace impact.
- **Depends on:** EDR 0004 (swing strength) — the range is anchored to a *strong* swing by definition; validated against the Dreimann ground-truth fixtures.

## Problem

The engine has no equilibrium concept (gap G4), so "long only in discount" — a gate both Dreimann (explicit) and Sanos (bonus tier) reference — cannot even be expressed. Phase 0 needs the read as passive instrumentation.

## The chosen definition

**Anchor at the most recent strong swing (either kind); span to the most extreme opposite-kind swing printed after it.** `equilibrium = (low + high) / 2`; strictly above is premium, strictly below discount, the exact midpoint "equilibrium". Null — a first-class outcome — when no swing is strong yet or nothing has printed beyond the anchor; a range is never fabricated from unproven swings.

Derived view, zero stored state, same replay convention as `strength.ts`/`liquidity.ts`: bar-limited window in, what-was-knowable-then out.

## Why anchored, not [last strong low, last strong high]

The research sketch (analysis.md §6) paired the last strong low with the last strong high. On the ground-truth fixtures that pairing **inverts in trends**: on zec-sl's 4h context as-of entry, the last strong high (429.25, from Jun 26) sits *below* the last strong low (425.08 → later 437.44), yielding a nonsense or empty range exactly where the trader was reading discount. The anchored form — last defended level to the extreme dealt since — reproduces the ranges the charts were drawn over:

| Trade | 4h range as-of entry | Entry | Read |
|---|---|---|---|
| zec-sl | 425.08 → 476.74 (eq 450.91) | 450.49 | **discount** (by 0.09% — the chart's own razor-thin read) |
| trx-tp3 | 0.32613 → 0.33289 | 0.32782 | **discount** |
| zec-tp | 443.82 → 511.99 | 462.74 | discount (observed; no trader claim) |
| ethfi-sl | 0.4108 → 0.4565 | 0.4245 | discount (observed; no trader claim) |
| jup-tp | 0.1987 → 0.2534 | 0.2340 | **premium — matching the trader's own note** ("risky because bullish BOS on H4 may already have completed") |
| fet-tp | 0.1675 → 0.1826 | 0.1773 | premium (observed; no trader claim) |

The two canonical weak-structure trades read discount; the one trade the trader himself flagged as chasing reads premium. That correspondence is the fidelity evidence.

## Choices recorded (initial, revisable in later phases)

- **Exact midpoint, no equilibrium band.** A band is a tunable threshold; this layer ships none (R5 — nothing here may be tuned against the fixtures). Consumers wanting a band can build one on the exposed midpoint.
- **The range keeps its anchor even after price leaves the range.** Re-anchoring waits for a new strong swing to prove itself — deliberately lagging, never anticipating.
- **Extreme = most extreme opposite *swing*, not raw candle wick.** Swing space throughout, consistent with EDR 0004; candle truth stays in `liquidity.ts`.
- **Degenerate guard:** if the extreme ends up on the wrong side of the anchor (possible only in pathological/deserialized inputs), return null rather than an inverted range.

## What was intentionally rejected

- **[lastStrongLow, lastStrongHigh]** — inverts in trends (above); rejected on fixture evidence.
- **Objective-aware ranges** (span to the weak high being targeted) — that is the Phase 1 draw-on-liquidity resolver's job; folding it in here would couple G4 to G3.
- **An equilibrium tolerance band** — see above.

## Validation performed

- 16 tests: null before any strong swing; anchor selection in up- and downtrends (mirror); extreme-not-nearest span; coherence with the strength view on every fixture series (anchor is strong, midpoint exact); classifyPrice at/above/below the midpoint; per-fixture as-of-entry range existence; discount asserted on the two claim-backed canonical trades; jup-tp premium asserted as reproducing the trader's risk note; a characterization pin of all six observed positions (labeled as observation, not ground truth).
- Full suite green, lint and typecheck clean.

## Future extension points

1. **Direction gating (later phase):** long-only-in-discount as an `intent.ts` overlay, once instrumentation has been observed live.
2. **Phase 1 objective resolver:** premium/discount position becomes a POI attribute (analysis.md §5.3).
3. **Equilibrium band calibration** — only via the extended harness, never against these fixtures.
