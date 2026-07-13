# EDR 0015: POI actionability lifecycle + iFVG — terminal states retained, still stateless

- **Status:** Accepted, implemented (2026-07-13)
- **Scope:** `derivePoiLifecycle` in `src/lib/engine/poi-lifecycle.ts`; `buildPoiMap` now derives all states through it, retains terminal POIs flagged, and mints iFVGs (G6). `zones.ts` gains the candidate-extraction seam (`computeBaseZoneCandidates` / `selectZoneCandidates`) with `computeBaseZones` re-expressed as candidates → `zoneFreshness` → `selectZones` — output byte-identical, pinned by EDR 0012's characterization tests. Display-plane only; verdicts, `selectPoi`, persisted records, and `ENGINE_VERSION` untouched.
- **Depends on:** EDR 0012/0013/0014 (the detectors + unified ledger), `zones.ts` freshness semantics (EDR 0001/0009 lineage).

## Problem

The engine's only lifecycle vocabulary was `zoneFreshness`'s fresh/tested, with invalidated and consumed zones silently dropped — the UI could never say "this POI died, here's how," and iFVG detection (an invalidated FVG _becoming_ the opposite POI) was structurally impossible because invalidation was an absence, not an event.

## The chosen rules

Still stateless — the state machine is **recomputed by candle replay** each evaluation, never persisted; a terminal state freezes at `decidedAt` so it is identical for every longer window (prefix-replay-pinned).

- **Five states.** fresh = never revisited after the post-formation linger (zoneFreshness' linger rule kept verbatim); tested = one shallow revisit, held; **mitigated** = one revisit penetrating ≥ 50% of the band (`MITIGATED_PENETRATION`, pre-gate revisable), held; **invalidated** = close through the distal edge; **consumed** = second distinct revisit. Terminal states are retained and flagged, not dropped.
- **Parity is a theorem, not a hope:** collapsing mitigated→tested and terminal→dropped reproduces `zoneFreshness` exactly — asserted over every base-zone candidate across all Dreimann fixtures + synthetic tape. The linger neither counts touches nor penetration (else every zone would be born "mitigated" by its own formation).
- **iFVG (G6):** an FVG whose gap a bar closes fully through is `inverted` (for an FVG, invalidation _is_ inversion); `buildPoiMap` mints one opposite-kind `ifvg` POI at the inversion bar, whose own lifecycle is replay-derived like any band — "delivery" is simply the iFVG's first test under the same state table, emit-once by construction. An invalidated iFVG never re-flips. `filledFraction` (deepest gap penetration, 0..1) is recorded for the FVG family only.
- **Zone candidates on the ledger:** the token page feeds `selectZoneCandidates(computeBaseZoneCandidates(...))` so dead zones appear flagged. Known, accepted divergence: curating candidates _before_ the freshness filter can pick a recently-dead base over an older live one `computeBaseZones` keeps, so the card's zone rows and the chart's zone bands can occasionally differ — the chart (and everything decision-adjacent) still uses `computeBaseZones` unchanged.
- **Chart draws only non-terminal bands** (clutter control); the card lists everything, terminal rows struck through.

## What was intentionally rejected

- **Persisting lifecycle transitions** — state in the engine violates the replay-safety posture; the record plane is the worker's, and nothing here has earned a record stream.
- **A bespoke delivery flag** — the iFVG's own state table already expresses it; a second mechanism would drift.
- **Editing `zoneFreshness`** — it stays the frozen reference the parity test pins against; the deriver is a sibling, not a replacement.

## Validation performed

- 13 lifecycle tests: full state table (incl. linger neutrality, the ≥ boundary on mitigation, decidedAt freezing), FVG fill/inversion vs zone null-fill, the **zoneFreshness parity sweep**, and terminal-state prefix-replay. poi-map tests updated: terminal OBs retained flagged, iFVG minting (bullish gap → supply iFVG at the inversion bar), selectPoi parity restated across the tested|mitigated split (rank-equal, so selection parity holds).
- `computeBaseZones` byte-identity: EDR 0012's characterization suite passes unmodified against the refactor.
- Full suite green (842), typecheck clean; inertness snapshots untouched.

## Future extension points

1. **Cutover gate** (EDR 0014's): when `selectPoi` widens, the state field is already richer than `freshness` — whether mitigated ranks below tested becomes a measurable question.
2. **Lifecycle chips on more surfaces** (alignment card, AI-analyst context) once the vocabulary proves legible.
