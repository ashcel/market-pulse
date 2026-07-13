# EDR 0012: FVG detection + the normalized size floor — 3-candle imbalance, detection only

- **Status:** Accepted, implemented (2026-07-13)
- **Scope:** `detectFvgs` / `selectFvgs` in `src/lib/engine/fvg.ts` (gaps G5 + G7, analysis.md). Pure addition: imported by no engine decision path, no verdict, score, or keyspace impact — display-plane work toward the POI unification (the "Phase 3" named in `poi.ts` and EDR 0009 §Future 3).
- **Depends on:** `zones.ts` for `atrSeries` (visibility-only export; `computeBaseZones` untouched) and the `SD_ZONE_TIMEFRAMES` gate it shares.

## Problem

The engine's only POI type is the base zone. The methodology's second POI family — the fair value gap — had a spec in the roadmap (analysis.md G5: bullish when `low[i] > high[i-2]`, gap `[high[i-2], low[i]]`) but no code, which blocks the OB/FVG/zone unification and everything downstream of it (lifecycle, iFVG).

## The chosen rules

Initial deterministic choices, revisable while nothing acts on them (R5):

- **Detection is the literal 3-candle imbalance**, one forward pass over closed bars; a gap confirmed at bar `i` reads only bars ≤ `i` — replay-safe by construction, pinned by prefix-window tests.
- **Size floor (G7): `gap / ATR14 ≥ 0.25`**, with the ATR reference taken **before the displacement candle** (`atr[i-2]`) so the displacement's own true range can't inflate its yardstick — the same stance `computeBaseZones` takes for departure candles. `MIN_FVG_SIZE_ATR` is exported and pre-gate revisable.
- **ATR-less gaps are kept with `sizeAtr: null`**, not judged by a reference that doesn't exist yet (first 14 bars of a window); `sizePct` is always recorded.
- **Detection carries no filled/inverted state.** An FVG's identity is fixed at formation; what happened to it since (touches, fill fraction, inversion → iFVG per G6) is a replay question that belongs to the lifecycle deriver, which also unlocks iFVG emission. Deliberately sequenced after unification.
- **`selectFvgs` curates for display** the way `selectZones` does: ranked candidates (preferred = `[0]`), most recent first with gap size as tie-break, overlapping same-kind duplicates dropped, capped at 3 per kind.
- **Timeframe gate = `SD_ZONE_TIMEFRAMES`** (1H+). The methodology does read intraday FVGs; widening is a display decision to revisit once the lifecycle view exists, not a detection question.

## What was intentionally rejected

- **A percent-of-price floor** as the primary filter — not volatility-aware; kept only as recorded context (`sizePct`).
- **Dropping ATR-less gaps** — silently losing early-window structure to an accounting artifact.
- **Marking filled/inverted state here** — would make detection output depend on the full window tail and split the lifecycle question across two modules.

## Validation performed

- 20 tests across `fvg.test.ts` + the new `zones.test.ts`: bullish/bearish detection and exact gap bounds, the touching-candles non-gap, the G7 floor both sides with the pre-displacement ATR reference pinned, determinism + prefix-replay sweeps over three mock series ("a confirmed gap never changes as the window grows"), selection ranking/cap/overlap rules.
- `zones.test.ts` additionally **characterizes `computeBaseZones` byte-for-byte** (exact Dreimann as-of-entry zone sets incl. zec-sl's `[418.2, 425.92]` + `[455.58, 457.44]`; the pinned empty result on smooth synthetic tape; per-prefix structural invariants) — the safety net required before the planned candidate-extraction refactor for the lifecycle work touches `zones.ts`.
- Full suite green, typecheck + lint clean; `ENGINE_VERSION` untouched at 1.0.0.

## Future extension points

1. **Unified POI read model** — FVGs enter `buildPoiMap` alongside zones and order blocks (display-only; `selectPoi` keeps consuming `BaseZone[]` until the pre-registered cutover gate).
2. **Lifecycle deriver** — fill fraction, inversion (iFVG, G6) with delivery, emit-once first-touch-decides.
3. **Intraday widening** of `FVG_TIMEFRAMES` once lifecycle chips make dense bands legible.
