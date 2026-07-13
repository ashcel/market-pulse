# EDR 0014: Unified POI read model — one ledger, display-only, cutover-shaped

- **Status:** Accepted, implemented (2026-07-13)
- **Scope:** `buildPoiMap` / `rankPois` in `src/lib/engine/poi-map.ts`, the `PoiMapCard`, and the token chart's OB/FVG bands. **Display-only by decision:** `selectPoi` / `buildAnticipatoryPlan` keep consuming `BaseZone[]` alone, so the anticipatory/fill record stream is untouched and the Phase 0.5 graduation gate (15 settled fills on the base-zone model) keeps accruing on one definition. No verdict, score, or keyspace impact; `ENGINE_VERSION` stays 1.0.0.
- **Depends on:** `zones.ts` (EDR 0001/0009), `orderblocks.ts` (EDR 0013), `fvg.ts` (EDR 0012), `equilibrium.ts` (EDR 0005).

## Problem

Three POI detectors now exist but only base zones are visible to any consumer. The methodology treats zone/OB/FVG confluence as core context, and `poi.ts` has promised since Phase 1 that unification "widens this module's input type without reshaping consumers" — that seam needed to become a real type before the cutover gate can be designed.

## The chosen rules

- **`UnifiedPoi` is the cutover seam.** It carries exactly the fields `selectPoi` reads from a `BaseZone` — `kind`, `priceLow`/`priceHigh`, `startTime`, and `state` subsuming `freshness` — plus `source`, `position`, `sizeAtr`. The eventual gated cutover (pre-registered spike + version bump, not designed here) only widens `selectPoi`'s parameter to a structural interface both types satisfy.
- **`rankPois` is `selectPoi`'s ordering verbatim** (EDR 0009): reachable entry-kind POIs, discount-side first (premium mirror), fresh over tested, nearest proximal edge, earliest `startTime`. It returns the full ranked list (preferred = `[0]`), with terminal-state POIs (once the lifecycle deriver produces them) sinking below live ones but staying listed. Pinned by a parity test over every Dreimann fixture: base-zones-only input ⇒ `rankPois(...)[0]` ≡ `selectPoi(...)`.
- **No merging.** An OB inside its base zone, an FVG overlapping both — all listed. Collapsing overlaps would erase which detector said what; confluence is the display's job to show, not the type's job to hide.
- **State this phase is the `zoneFreshness` vocabulary** (fresh/tested; traded-through and twice-revisited drop out), applied to OBs and FVGs by the same replay rules zones already use. The full five-state lifecycle (mitigated/invalidated/consumed retained, iFVG emission) is the next module; `PoiState` already names those values so consumers don't reshape.
- **Position** = `classifyPrice` at the proximal edge (demand top / supply bottom); `null` without a dealing range, never a veto.
- **UI:** unified ledger card in the assistant panel (live data only, like the anticipatory card) grouped supply-above/demand-below with source badge, band, state, position; chart draws OB (indigo) and FVG (teal) bands under the existing S/D toggle, fainter than base zones. Both carry the explicit "display only — the plan still selects from base zones" line.

## What was intentionally rejected

- **Wiring unified POIs into `buildAnticipatoryPlan` now** — would fork the anticipatory record stream mid-sample and reset the fill-harness gate; user decision was display-first.
- **Merging overlapping POIs into consensus bands** — destroys detector attribution.
- **A separate chart toggle per source** — three toggles for one concept family; the S/D toggle governs all POI bands.

## Validation performed

- 9 tests: no-merge unification, freshness pass-through + FVG kind mapping, zoneFreshness-semantics touch scan on OBs (traded-through / tested / fresh), chronological ordering, `rankPois` ordering triples ported from `poi.test.ts`, terminal-state sinking, the **selectPoi parity sweep** over all six Dreimann fixtures × both directions, and determinism over full detector output on synthetic + fixture series.
- Full suite green (832), typecheck clean, production build passes; inertness snapshots untouched; no decision-path file imports `poi-map`.

## Future extension points

1. **Lifecycle deriver** — five states retained, iFVG emission, fill fractions; `buildPoiMap` switches its touch scan for the deriver without reshaping `UnifiedPoi`.
2. **The cutover gate** — pre-registered spike comparing base-zone-only vs unified selection on the fill harness, then `selectPoi` widens and `ENGINE_VERSION` bumps.
