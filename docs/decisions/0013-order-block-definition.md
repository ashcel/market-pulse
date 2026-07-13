# EDR 0013: Order-block definition — last opposing close before displacement

- **Status:** Accepted, implemented (2026-07-13)
- **Scope:** `detectOrderBlocks` / `selectOrderBlocks` in `src/lib/engine/orderblocks.ts`. Pure addition: imported by no engine decision path, no verdict, score, or keyspace impact — the second POI family for the unification (EDR 0012 is the first).
- **Depends on:** `zones.ts` for `atrSeries` and the shared timeframe gate. Explicitly a **sibling** to `computeBaseZones`, whose semantics are frozen: base zones find shelf-then-departure structures, order blocks find the last opposing candle — different POIs, both kept.

## The chosen rules

Initial deterministic choices, revisable while nothing acts on them (R5):

- **OB = the last opposing-close candle before a displacement candle.** Displacement reuses zones.ts' conviction gate verbatim (body ≥ 1.15×ATR14 with the reference at `atr[i-1]`, body ≥ 55% of range) — one set of conviction constants across the engine, not two calibrations to drift apart. These numbers are unvalidated for OBs specifically; that is a measurement question for the harness, not a reason to invent new thresholds now.
- **Walkback skips only indecision** (body ≤ 0.45×ATR — zones.ts' own threshold), at most 2 skips. A same-direction _conviction_ candle aborts: the leg was already running, the displacement is continuation, and continuation legs don't mint POIs.
- **Band = the OB candle's full range** (wick to wick), matching the zone convention that the distal edge is the wick extreme (the EDR 0009 stop lesson). Body-only banding is the named open alternative — narrower entries, but stops inside the wick noise; measurable post-gate.
- **`sweptSwing`**: the OB wick printed a new extreme against the prior 20 bars — the sweep-origin OB the methodology weights higher. Recorded as data for ranking/display, deliberately not a filter.
- **`selectOrderBlocks`** curates like `selectZones`/`selectFvgs`: ranked candidates (preferred = `[0]`) by displacement recency then displacement strength, same-kind overlap dropped, cap 2 per kind.
- Timeframe gate `OB_TIMEFRAMES = SD_ZONE_TIMEFRAMES`; replay-safe by construction (bar `i` reads only bars ≤ `i`), pinned by prefix tests on real fixture data.

## What was intentionally rejected

- **Volume confirmation** — engine inputs are OHLC-first; `BaseZone` has no volume either, and an unvalidated volume threshold is just a second tunable.
- **`sweptSwing` as a hard gate** — would encode a preference no harness has measured; it ranks and displays instead.
- **Editing `computeBaseZones` to "become" an OB detector** — destroys a calibrated detector mid-forward-test for a different concept.

## Validation performed

- 14 tests: demand/supply detection with exact bounds, both displacement conviction failures (body-vs-ATR, wick share), doji walkback, the continuation abort, sweep flagging, determinism + prefix-replay sweeps over real 4h fixture series, selection rank/cap/overlap, structural coherence over all Dreimann as-of-entry windows.
- **Annotation fidelity (recorded, not asserted):**
  - **zec-sl:** the OB read _agrees with the base-zone read_ — demand OBs at [418.20, 426.49] and [393.01, 403.64], plus supply at [437.77, 448.50]. The trader's ~450 demand box is **not** an order block under this definition in the captured window either; EDR 0009's "shallower POI" divergence stands unresolved rather than resolved by OB typing.
  - **jup-tp:** where base-zone detection found **nothing** as-of entry, a demand OB at [0.2287, 0.2414] spans the trader's 0.234 entry — the first concrete case of OB typing widening POI coverage; exactly what the unified read model exists to surface.
  - **ethfi-sl:** the dominant supply OB [0.4116, 0.4441] is sweep-origin (`sweptSwing: true`).
- Full suite green, typecheck + lint clean; `ENGINE_VERSION` untouched at 1.0.0.

## Future extension points

1. **Unified POI read model** — OBs enter `buildPoiMap` beside zones and FVGs, state derived by the lifecycle module.
2. **Post-gate measurements:** body-only banding, sweep-origin as filter vs rank, OB-specific displacement calibration.
