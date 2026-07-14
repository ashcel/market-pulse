# M3 — Per-trade behavior forensics

**Goal:** honest, per-trade observable metrics about how the user actually
traded — entry quality, management, exits, sizing, timing. Everything in this
milestone is measurable on a **single trade** with no statistics, which is why
it comes before any cohort claim. This is the "review your behavior" core.

**Depends on:** M1 (positions + stop evidence), M2 (context stamps).

## Success criteria (all measurable)

- [ ] Every closed position has: MAE, MFE (in % always; in R iff a stop order
      was evidenced per EDR 0017), exit efficiency, hold time vs stamped
      intent horizon, and a management timeline.
- [ ] `docs/forensics-definitions.md` defines every metric with its exact
      formula, its evidence basis, and its known failure modes — committed
      **before** the UI that shows it.
- [ ] Counterfactual settlements (held-to-stop/target) are computed with the
      same first-touch-wins kline-walk semantics as `settleShadowSignal`,
      fixture-tested, and always labeled "counterfactual" in the UI.
- [ ] Zero cohort/aggregate performance claims in this milestone's UI —
      aggregates shown are counts and distributions only (a histogram is
      fine; "you have edge when…" is not).
- [ ] The R rule holds: positions without stop evidence show no R anywhere
      (test-asserted).

## Metric set (build in this order)

1. **MAE/MFE** — max adverse/favorable excursion between entry and exit,
   from klines at the execution timeframe stamped in M2.
2. **Exit efficiency** — realized PnL ÷ MFE (how much of the available move
   was captured); defined only when MFE > 0.
3. **Stop discipline** — for stop-evidenced positions: was the stop moved,
   widened, removed? Exit beyond original stop distance = discipline breach,
   itemized.
4. **Counterfactuals** — "held to original stop/target" settlement; "honored
   the original stop" settlement. Reported as R/% deltas vs realized.
5. **Sizing consistency** — position risk (stop-evidenced) or notional
   (otherwise) as % of a user-set account size; variance and outliers.
6. **Timing behavior** — session/time-of-day of entries; re-entry latency
   after a realized loss (the revenge-trade tell); weekend/news-window flags
   from stamped events.

## Tasks

- [ ] **M3-T1 — Definitions doc.** Write `docs/forensics-definitions.md` for
      the full metric set above, formulas + failure modes (e.g. MFE on a
      position that was added-to mid-life; funding in PnL for efficiency).
      *DoD:* committed; each metric has formula, inputs, R-vs-% rule applied.
- [ ] **M3-T2 — Excursion walker.** Pure module: position + klines →
      MAE/MFE/excursion series, honoring adds/partial closes (size-weighted).
      Fixture suite incl. add and partial-close cases.
      *DoD:* deterministic; % always, R only with stop evidence.
- [ ] **M3-T3 — Exit efficiency + hold-time.** On top of T2; hold time
      compared against the stamped intent horizon (from M2 context).
      *DoD:* fixtures incl. the MFE=0 undefined case rendering as "n/a".
- [ ] **M3-T4 — Counterfactual settler.** Reuse/extract the kline-walk
      settlement core; settle "original plan honored" variants; store next to
      realized outcomes, `kind='counterfactual'`.
      *DoD:* shares semantics with `settleShadowSignal` (shared fixtures);
      never mutates real outcome rows.
- [ ] **M3-T5 — Stop discipline + sizing.** Stop-move detection from order
      history; risk-% series with user-set account size in settings.
      *DoD:* a known stop-widened fixture flagged; sizing chart data correct.
- [ ] **M3-T6 — Timing behavior.** Session/time-of-day tagging (reuse
      `sessions.ts`), re-entry latency after loss, event-window flags.
      *DoD:* fixtures; latency histogram data available per user.
- [ ] **M3-T7 — Forensics worker pass.** Compute + persist all metrics for
      closed positions (migration `0008`, `trade_forensics`); idempotent;
      recompute-on-definition-version-bump supported.
      *DoD:* owner's full history computed; re-run writes 0 changes.
- [ ] **M3-T8 — Trade-detail forensics UI.** Per-trade section: excursion
      chart (entry→exit path with MAE/MFE markers), efficiency, counterfactual
      deltas (labeled), stop-discipline flags, all with definition tooltips
      linking to the doc.
      *DoD:* renders for stop-evidenced and non-evidenced positions
      correctly (R hidden on the latter).
- [ ] **M3-T9 — Journal distributions view.** Counts and histograms only:
      efficiency distribution, hold-time vs intent, sizing variance, re-entry
      latency. Copy explicitly avoids performance claims.
      *DoD:* string-level test that no "edge"/"expectancy" claim appears in
      this view.
