# EDR 0016: Trend-transition derivation — hint → confirm as records

- **Status:** Accepted, implemented (2026-07-13)
- **Scope:** `deriveTrendTransitions` / `latestTransition` in `src/lib/engine/trend-transition.ts`; transition badges on the structure-alignment card. `structure.ts` change is visibility-only (`trendFrom` exported so the deriver can never disagree with the structure's own trend fold). Display-plane: read by no verdict — `hysteresis.ts`'s contextBias-flip release stays the only trend reactivity in the decision path.
- **Depends on:** `structure.ts` (swing labels/events, frozen per swing — its replay-safety rule is what makes this fold safe).

## Problem

The structure exposes a _current_ trend and discrete CHoCH/BOS events, but nothing connects them into "the downtrend CHoCH'd at swing X and confirmed as an uptrend at swing Y". Consumers (the alignment ladder, the coming RS scan's rotation flags) need transitions as data, and a CHoCH alone is a hint, not a regime change — conflating them is exactly the error the two-phase record prevents.

## The chosen rules

- **Pure forward fold over `structure.swings`**, re-running `trendFrom` per swing — the identical evolution `computeMarketStructure` maintains, parity-asserted ("fold's final trend === structure.trend") across synthetic + fixture windows.
- **`choch-hint`** on a CHoCH swing: the record opens with `from` = the prevailing trend, `to` = the break direction, `confirmSwing: null`.
- **`confirmed`** when the running trend actually flips: a pending hint pointing that way upgrades _in place_ (one record tells the whole hint→confirm story, `time` advancing to the confirming swing); a flip with no hint — structure forming out of a range — confirms directly with `chochSwing: null`.
- **A hint survives the range interlude** (a CHoCH's HH beside a stale LL reads range by construction — killing hints on range would kill every hint) and **dies on an opposing extreme break** (a new LL against an uptrend-hint: the market resumed). Dead hints stay in history, unconfirmed — a failed reversal is information.
- **Falls into range are not records**; the next transition's `from` carries them.
- **Prefix guarantee stated on swing prefixes**: a record confirmed at swing ≤ m is identical in every longer fold. Candle-window prefixes are deliberately _not_ the contract — `computePivots` adapts its pivot window to series length, so the pivots themselves reshuffle; this matches structure.ts's own live-behavior caveat.
- **UI:** one chip per timeframe row on the alignment card — "down→up" (confirmed, trend-toned) or "up? awaiting confirm" (hint, warning-toned) — beside the existing BOS/CHoCH chip.

## What was intentionally rejected

- **Feeding transitions into hysteresis/verdicts** — a semantics change; requires a pre-registered spike + `ENGINE_VERSION` bump (noted, not designed).
- **Emitting trend→range records** — every pullback would mint one; ranges are the space between trends here.
- **A BTC 1D transition notification** — deferred until the badge proves legible; the `lastRegimeLabel` string-diff pattern in `notifications.ts` is the slot when wanted.

## Validation performed

- 6 tests: hint→confirm narrative (CHoCH swing + confirming swing pinned), hint surviving the range interlude as `latestTransition`, failed-hint retention (a later flip mints a fresh record, never upgrades the dead hint), range→trend formation with null `chochSwing`, the trend-parity + structural-coherence sweep over mock and all Dreimann windows, and swing-prefix determinism.
- Full suite green (848), typecheck clean; no decision-path imports.

## Future extension points

1. **RS scan rotation flags** — `latestTransition` over 1D structure per enriched ticker.
2. **Gated promotion** into verdict semantics (e.g. transition-aware hysteresis release) via spike + version bump.
