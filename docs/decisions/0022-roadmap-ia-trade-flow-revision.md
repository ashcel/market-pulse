# EDR 0022: Roadmap, IA, and trade-flow revision — 2026-07-23

- **Status:** Accepted (2026-07-23) — owner directed implementation via delegation
- **Scope:** product plan, information architecture, and execution-plane user-input correctness. No engine decision/trigger semantics and no `ENGINE_VERSION` change — the 2.0.0 forward-test clock keeps running untouched.
- **Amends:** EDR 0020 (leverage/margin-mode user inputs + liquidation/drift guards); **supersedes** the M0–M9 milestone sequencing in `milestones/README.md` (now R0–R6 roadmap).
- **Companions:** `milestones/TRADE-FLOW-2026-07-23.md` (execution audit + ticket redesign spec), `milestones/ROADMAP-2026-07-23.md` (milestone review + R0–R6 reordering), `milestones/IA-REDESIGN-2026-07-23.md` (navigation + screen restructure).

## Problem

The original M0–M8 plan assumed linear build; reality diverged. EDR 0020's execution plane shipped Phase A (constitution + permits + sizing); START-HERE moves delivered a verdict-first home; the Python worker (EDR 0018) reset the forward-test clock. The milestone spine — originally gating skip check on M5 cohort statistics — is now proven wrong: the deterministic risk desk built in M9 already gates trades and refusals bind. Meanwhile M7 (TradFi mode) claims breadth without decision value, M5/M2/M8 remain unbuilt while their evidence is accumulating, and the three-doc audit (TRADE-FLOW, ROADMAP, IA-REDESIGN) names the structural insight: re-anchor skip check on the deterministic desk, collapse redundant trade surfaces into one journal, and slim the IA from decoration toward decision.

## The decisions

### Roadmap decisions

**1. M7 TradFi mode removed.** The valuable macro kernel already shipped via TradFi news ETL + econ calendar (context input to crypto verdicts, no new asset class). Session abstraction, reconciliation walkers, and instrument-class multipliers add cost/complexity for unproven demand. Re-entry requires evidenced user demand + its own EDR.

**2. M5 cohort analytics deferred.** Pre-registered statistics are the most honest milestone — precisely because they're honest, they render "insufficient evidence" for months at realistic n. Per-trade forensics (MAE/MFE, stop discipline, re-entry latency, sizing variance, habit-naming) deliver the actionable subset now without synthetic precision. **Re-entry trigger:** n≥30 closed, stamped trades in major segments; protocol frozen before any UI ships.

**3. M2 historical replay backfill deferred.** Redesigned to stamp-at-open only (context card on every trade from now on, cheap, delivers user value). Full replay is expensive and its main consumer was M5; it defers with M5. **Re-entry trigger:** M5 un-defers (M5 is the primary consumer).

**4. M8 productization split.** Three tasks are operational safety for a box holding a live execution key (deploy path, backup/restore, alerting completeness) — merge into R0. Onboarding, multi-user suites, sync budgets deferred. **Re-entry trigger:** owner runs the full loop 4+ consecutive weeks and recruits a second user (standing guardrail: multi-user schema discipline from day one).

**5. M6 skip check re-anchored.** Original spine gated it on M5 cohort statistics (months away). **Redesigned spine:** dry-run Trade Permit (risk engine + constitution + sizing + exposure, no order intent) + regime verdict + catalyst-impact window + deterministic behavior flags (M9-T11). Cohort claims join M5's undefer; until then those blocks render "no opinion — insufficient evidence" as first-class output. This moves skip check from M5's dependent to M9's consumer, placing it immediately after the risk desk completes.

### Information architecture decisions

**6. Navigation — five task-named slots.** Today (Q1: "should I trade now?") · **Check** (Q2: "is this trade good?", center-positioned on mobile as visual primary) · Journal (Q3: "am I trading well?") · Markets (evidence, tabs) · Settings (config). **Deletions:** Pro upsell card, fake plan badge, market clock, News nav item, nav group labels. **/tracker** route becomes the **Record** tab inside /markets (it is engine evidence, not the user's journal). **/trades + /review** merge into **/journal**.

**7. Home slimmed to one screen.** Regime verdict + open risk + 2–3 live setups + catalyst rail + Check entry point. **Deleted:** hero tiles, tape strip, legacy top-setups, overview strip, top-assets table (→ Markets), news highlights (→ catalyst rail), heatmap/F&G tiles (→ Markets→Regime), ambient AI block (→ on-demand desk review). Net: no desktop scroll, one short scroll on mobile.

**8. Token page — verdict first, evidence summoned.** Verdict header (always visible, per-objective chips) + chart (existing overlay) + collapsed evidence accordion (structure/SR/liquidity/POI, track-record stats, context). Each evidence card cites which verdict line it supports; cards supporting no line are deleted. Target ≤20 cards (from ~70). 4,250-line file splits into feature components (mechanical, no behavior change).

**9. Journal merge.** Single `/journal` route with three tabs: **Open** (live positions, permit-linked, trade-lock actions, event windows), **History** (closed trades with facts/stamp/forensics/memo), **Habits** (1–2 named habits with evidence counts, no edge claims). One header, one filter system, PnL/R rules per EDR 0017 throughout.

### EDR 0020 amendment — leverage & margin mode as user inputs

**10. Leverage and margin mode become explicit user choices.** They do not affect *how much* risk is taken (that derives from balance × stop distance × risk%) but *how* the risk is carried (margin efficiency, liquidation placement). Default margin mode: **Isolated** (contained blast radius is beginner-correct). Margin mode can be locked to an open position's mode if the symbol already has a position in the other mode (exchange constraint). Leverage: chips 1× · 2× · 3× · 5× · 10× · custom, capped at constitution `max_leverage`; disabled chips render with "liquidation would sit inside your stop" (see decision 11).

**11. Max-risk-at-leverage rule (deterministic).** Leverage caps notional: `max_notional = balance × leverage`. With stop distance `d`, **max achievable risk% = max_notional × d / balance**. Ticket always shows the live triple: requested risk% · max achievable at current leverage · liquidation price + distance vs. stop. **Rule:** requested ≤ achievable → size normally, leverage sets margin efficiency. Requested > achievable → ticket caps to achievable, says so ("2% requested, 1.6% possible at 2× — raise leverage or widen risk band"), permit records the cap. Liquidation inside the F2 buffer → chip shows inline rejection before permit request.

**12. Liquidation inside stop check (F2, critical).** `LIQUIDATION_INSIDE_STOP` hard check: liquidation must be at least a configured buffer (default 20% of stop distance) *beyond* the stop, else `REJECTED` with the reason and the max leverage that would pass. **Liquidation estimate:** tiered maintenance brackets from `exchangeInfo` (deterministic); isolated: per-position estimate; cross: conservative isolated-equivalent price, UI labels as conservative. Every liquidation render carries "estimate" labeling (M0 honesty rules).

**13. Entry drift guard at permit consume (F4).** Permit TTL is 90 s. At consume, fetch mark price; if drift from proposal entry exceeds a bound (default 25% of stop distance), reject with `ENTRY_DRIFT` — user re-checks in one tap. Drift numbers are deterministic, never guessed.

**14. Leverage/margin-mode sync before entry (F1, critical).** Before order submission, set margin mode + leverage per permit, read back `positionRisk` to confirm, **abort if exchange rejects the change** (e.g., existing position in the other mode). Divergence is a hard stop, never a warning. Every permit's margin, effective-leverage, and liquidation numbers are now guaranteed to describe the position that actually opens.

**15. Ticket UI — leverage + margin mode first-class inputs.** Stop (pre-filled from plan), risk% slider (0.5–3%), **leverage chips** (capped at F2-safe bound, disabled chips show reason), **margin mode toggle** (Isolated default, locked if symbol has open position in other mode, one-line explainer under each). Live-computed line (read-only, recomputed per input): qty, notional, required margin, effective leverage, liq price + F2 buffer distance, and the §11 max-risk triple. Permit auto-requested (debounced ~500 ms), card renders inline (TQS + checks + decision, TTL countdown ring on APPROVED). Two depths same screen: Simple (defaults, mobile default, "Adjust" disclosure) + Pro (all controls visible, pref persisted). Both run identical permit path.

## What was intentionally rejected

- **Quantity input anywhere** — sizing derives from balance × stop distance × risk%, never a user-supplied number.
- **Leverage suggestion from AI** — deterministic desk gates what's possible; AI narrates, never originates sizing choices.
- **Cross-margin default** — isolated is the beginner-correct, lower-blast-radius default; users move to cross after proving consistency in isolated.
- **Permit bypass at any depth** — simplicity is presentation; permits always run.
- **Mainnet before U24** — everything above testnet-provable first; U24 (infra-isolation decision, owner-bound) gates mainnet enable (R6).

## Validation performed

Docs-only spec (TRADE-FLOW, ROADMAP, IA-REDESIGN, this file). Measurable validation lives in the R0–R6 roadmap DoDs: F1–F4 in the order service with the M9 test discipline (fixtures, negatives, testnet round-trip); R1–R6 screens built against the IA spec per roadmap matrix (agent fit: Opus for cross-plane design, Sonnet for features, Haiku/Flash for sweeps); roadmap re-entry triggers (M5 n≥30, M2 sync to M5, M8 user cohort demand) freeze before any UI ships.

## Future extension points

1. **M5 pre-registered cohort protocol** — when n≥30 matures in major segments, the frozen protocol document (written *before* UI) is executed; extends evidence discipline from per-trade (R4) to statistical claims.
2. **M2 historical replay backfill** — when M5 un-defers, replay becomes the consumer; the existing context-stamp foundation makes it a straightforward follow-on.
3. **M7 TradFi mode** — when a real user cohort trading Binance TradFi tickers asks for it (not claimed, asked), it starts from the T1 instrument survey and gets its own EDR.
