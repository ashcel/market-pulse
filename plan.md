# Token page — follow-up log

All five items flagged during the 2026-07-09 glance redesign are now
implemented on `feat/market-structure-model`.

## Done — engine/UI hygiene (2026-07-09)

1. **Risk grade moved engine-side** — `gradeRisk(atrPercent, counterTrend)` in
   `quant.ts` owns the ATR bands (<2.2 low, <4.5 medium, else high) plus a
   one-level counter-trend bump. Both the Overview "Risk level" stat and the
   Details volatility insight read it; unit-tested in `quant.test.ts`.
2. **Sweep recency moved engine-side** — `currentSweep(sweeps, candles)` in
   `quant.ts` exposes the same 3-bar rule setup classification already used
   internally (`SWEEP_SETUP_RECENCY_BARS`). The glance strip's Liquidity chip
   headlines a raid exactly while the engine still treats it as a trigger;
   tested in `sweep-setups.test.ts`.
3. **Chart didn't shrink on live viewport resize** — `min-w-0` on the chart
   grid column; verified by resizing 1600→390 in the browser.

## Done — product decisions (2026-07-10)

### A. Plan pinned to the objective's execution timeframe

The chart's plan overlays (entry/stop/target lines and the reward/risk/entry
zones) now come from `activeAssessment.plan` — the intent's execution-TF plan,
the same one the panel quotes — instead of the chart timeframe's
`evaluation.risk`. Candles remain freely explorable via the timeframe buttons.

- `TokenChart` takes `plan` / `planTimeframe` / `planStrong` props; the level
  series and `computeSetupZones` read only those.
- Zones gate on the verdict (`planStrong` = favored/caution), replacing the
  old `evaluation.decision` gate (`hasStrongSetup` deleted).
- The legend labels the source explicitly — "Trade plan · 1H" / "Trade zones ·
  1H" — and the plan/zones hints + product tour explain the pinning.
- Verified live: with the Intraday objective, switching the chart 1H→15M keeps
  the lines at the identical prices and the "· 1H" label.

### B. Confidence presented as read strength

The raw `evaluation.confidence` is untouched (hysteresis, tracker, and shadow
record all key off it — never rescale or cap it). Presentation only:

- `ConfidenceGauge` gained an optional `tone` prop (CSS color) overriding its
  value-based green/amber/red scale; other callers are unchanged.
- New `ReadStrengthGauge` in the Overview hero: ring tinted by verdict
  (favored → direction color, caution → warning, wait → info, avoid → muted),
  captioned "Read strength", with a verdict-specific hint — for "wait":
  "the engine is confident about the direction while the entry conditions are
  still unsatisfied".
- Verified live: "SHORT · NOT YET" beside a blue 53% "READ STRENGTH" ring.

## Still open (not scheduled)

- Dev-only hydration noise from `data-tsd-source` attributes (tooling, not
  product).
- CLAUDE.md says "there is no test suite" — there is one now (vitest;
  `bunx vitest run`). Worth fixing next time CLAUDE.md is touched. Note
  `bun test` shows 3 false failures in `quant.test.ts` (bun's `vi` shim lacks
  `doUnmock`); use vitest.
