# EDR 0018: Engine 2.0.0 — Python port resets the forward-test evidence clock

- **Status:** Accepted (2026-07-16, migration plan approval); recorded 2026-07-17 before Phase 1 build
- **Scope:** `engine/smc/version.py` (`ENGINE_VERSION = "2.0.0"`); every forward-test record the Python worker writes. The TS engine's frozen `1.0.0` (`src/lib/engine/version.ts`) keeps serving prod and keeps writing `1.0.0` rows until its domain is cut over (migration Phases 3–4).
- **Depends on:** `docs/migration-plan.md` (approved full rewrite); EDR 0011 (record semantics are version-segmented).

## Problem

The migration ports the engine TS→Python. The forward-test record's whole value is
provenance: stats segment by `ENGINE_VERSION`, and the verdict protocol (frozen
2026-07-12) pins its n≥150 gate to the `1.0.0` record. A port can be *correct* without
being *byte-identical* — float formatting, iteration order, and idiom differences will
produce occasional divergent candidates even with identical semantics. Pretending the
Python engine is the same instrument would poison the record.

## Decision

- The Python engine ships as **`ENGINE_VERSION = "2.0.0"`** and its records start at
  **n=0**. No `1.0.0` row is ever written by Python; no `2.0.0` row by TS.
- **Byte-parity with the TS engine is explicitly not required.** Correctness is proven
  against the Dreimann ground-truth fixtures (ported verbatim) plus each module's
  ported test suite. A diagnostic live-symbol parity spike may log divergences;
  unexplained *category* flips (e.g. favored long vs favored short on the same input)
  are bugs, numeric drift is not.
- The `1.0.0` record stays intact and readable forever (verdict protocol untouched);
  the TS worker keeps accruing `1.0.0` evidence until Phase 4's shadow period ends.
- Accepted trade-off: the 1.0.0 sample accrued to date does not transfer; the n≥150
  verdict gate restarts on the 2.0.0 clock.

## What was intentionally rejected

- **Porting with byte-parity as the gate** — would freeze Python idiom to TS quirks and
  make every float-formatting difference a blocker, for no evidentiary gain since the
  version boundary already segments stats.
- **Keeping `1.0.0` for the Python engine** — same instrument label on a different
  instrument; violates EDR 0011's boundary.
