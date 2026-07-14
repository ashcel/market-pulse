# M5 — Cohort analytics (pre-registered)

**Goal:** the first honest aggregate claims about *where* the user performs:
expectancy and behavior segmented by stamped conditions (regime, session,
setup, intent, engine-verdict-at-open). Built under the same pre-registration
discipline as the engine's own verdict protocol, because this is exactly where
fake precision would creep in.

**Depends on:** M2 (segmentation dimensions), M3 (outcome metrics).

## Success criteria (all measurable)

- [ ] `research/behavior-cohort-protocol.md` is written and committed
      **before any cohort UI exists** (enforced by task order): declared
      segment family, minimum n per claim (30), CI method (t-based for R/%
      means, Wilson for rates), multiplicity correction (Holm across the
      family), and the exact wording rules for below-threshold segments.
- [ ] Every displayed cohort claim carries n and a 95% CI; segments below
      min-n render "insufficient evidence (n=…)" — test-asserted, not
      convention.
- [ ] The engine-verdict-as-filter analysis (trades taken *with* vs *against*
      the stamped verdict) is computed on the user-trade record only — a
      test asserts it reads zero rows from `shadow_signal` (verdict-protocol
      firewall intact).
- [ ] A "Your conditions" page exists showing the declared family and nothing
      exploratory; exploratory cuts live behind an explicitly-labeled
      "exploratory — no evidence weight" section.
- [ ] Recompute is deterministic and idempotent; cohort rows carry the
      protocol version.

## Declared segment family (finalized in T1, this is the starting proposal)

1. Regime at open (from M2 stamp)
2. Session at open
3. Intent-horizon bucket (from hold-time vs intent mapping)
4. Setup type at open (engine read, descriptive)
5. Engine verdict at open (favored/caution/wait/avoid) — the filter analysis
6. Market (spot vs perp)
7. Day-of-week
8. Position size tercile

Anything else is exploratory by definition.

## Tasks

- [ ] **M5-T1 — Write and freeze the protocol.** Finalize the family, min-n,
      CI/multiplicity rules, outcome metric (net realized % per unit risk
      where stop-evidenced, else net % — mirrors EDR 0017), and wording
      rules. Follows `verdict-protocol-1.0.0.md` structurally.
      *DoD:* committed; referenced by every later task; marked FROZEN.
- [ ] **M5-T2 — Stats primitives reuse.** Extract/reuse `meanWithSe`, Wilson,
      Holm from the forward-test stats code into a shared module (no behavior
      change to existing callers — parity tests).
      *DoD:* existing forward-test tests still green; shared module tested.
- [ ] **M5-T3 — Cohort computation service.** Pure module + worker pass:
      user positions × declared family → per-segment n, mean, CI,
      Holm-adjusted flags; persisted (`0009_behavior_cohorts.sql`) with
      protocol version.
      *DoD:* fixture suite incl. a below-min-n segment and a
      Holm-boundary case.
- [ ] **M5-T4 — Verdict-filter analysis.** With-vs-against verdict cohorts +
      the shadow-record firewall test.
      *DoD:* firewall test green; results carry the same CI discipline.
- [ ] **M5-T5 — "Your conditions" UI.** The declared family only: segment
      cards with n, CI bars, insufficient-evidence states; wording from the
      protocol's rules.
      *DoD:* string-level test for claim wording; UI matches protocol.
- [ ] **M5-T6 — Exploratory section.** Clearly-fenced exploratory cuts
      (labeled "no evidence weight"); a one-click path to *propose* promoting
      a cut into the family (which means a protocol amendment, documented).
      *DoD:* labeling test; promotion flow writes an amendment stub.
- [ ] **M5-T7 — AI narration hookup.** Feed cohort results (with n/CI) into
      the M4 memo/brief builders; the model may narrate only claims the
      protocol allows to be displayed.
      *DoD:* groundedness harness extended to reject narration of
      below-min-n segments (seeded fixture).
- [ ] **M5-T8 — First cohort report.** Run on the owner's full history;
      commit `docs/behavior-report-001.md` (may be redacted to relative
      numbers): what clears min-n today, what doesn't, time-to-evidence
      estimates per segment at the observed trade rate.
      *DoD:* report committed; every claim in it protocol-compliant.
