# Revalidation plan — V0 to V6 (2026-08-04)

Supersedes the R0–R6 roadmap (`ROADMAP-2026-07-23.md`) and the M0–M9 map in
`README.md` as the active plan. Direction is fixed by
[EDR 0024](../docs/decisions/0024-purpose-revalidation.md): four jobs — **READ,
VERDICT, CHALLENGE, DISCIPLINE** — and J3 CHALLENGE is the thin one.

Methods in V1–V5 are taken from *Python for Algorithmic Trading Cookbook*
(Strimpel, Packt 2024), `research/PYTHON_FOR_ALGORITHMIC_TRADING_COOKBOOK.pdf`.
Chapter references are given per task. What the book offers that this repo
lacks is not strategy — it is **the standard set of tests you run against your
own claims**. That is exactly the missing job.

Nothing in V0–V5 changes engine decision or trigger semantics, so
`ENGINE_VERSION` stays at 2.0.0 and the forward-test clock keeps running.

---

## Milestone order and why

| # | Milestone | Job | Blocks |
| - | --------- | --- | ------ |
| V0 | Purpose commit + prune | — | everything (don't build twice across two tiers) |
| V1 | IC harness — does any score predict anything | J3 | V3 |
| V2 | Beyond-chart statistics | J1 | — (ships behind V1's gate) |
| V3 | Verdict stability + honest horizon | J3 | needs V1 |
| V4 | Risk watch on the live book | J4 | — |
| V5 | Journal forensics — the standard set | J4 | — |
| V6 | One screen, one tier | J2 | after V0 |

---

## V0 — Purpose commit and prune

Goal: the tree contains only code with a claim on one of the four jobs.

- **V0-T1** Land EDR 0024. Get owner sign-off on Decision 4 (execution split).
  *DoD:* EDR status flips Proposed → Accepted with the owner's call recorded.
- **V0-T2** Land the uncommitted derivatives work already in the tree (8 files,
  +381). It is the reference implementation of the "never a raw metric alone"
  rule. *DoD:* committed; `pytest backend/tests/test_derivatives_summary.py`
  green; `DERIVATIVES_ENABLED=1` verified live.
- **V0-T3** Delete `app/bybit/` (1,238 lines) and `worker/bybit_sync_pass.py`.
  Both inert since the Binance re-source. *DoD:* `grep -rn bybit backend/app`
  returns only historical docstring mentions; `pytest` green; arq worker
  restarts clean.
- **V0-T4** Delete the four redirect-stub routes and fold nav to V2 (Now ·
  Ideas · Book · Lab). *DoD:* `VITE_NAV_V2=1 bun run build` clean, no dead
  `to:` targets, `routeTree.gen.ts` regenerated not hand-edited.
- **V0-T5** Decide `app/quant/` + `app/tradeway/`: finish the forecast port
  (`PORT_FORECAST=1`) or drop the surface. *DoD:* no proxy to the external
  notifier-bot dashboard remains in a code path a user can reach.
- **V0-T6** [after V0-T1 sign-off] Park the order-placement half of
  `app/execution/` on `park/execution-orders`; keep constitution, sizing,
  liq-vs-stop, permit, skip check on `main`. *DoD:* branch pushed; `main`
  has no exchange-key custody and no order transmission; permit path still
  renders end to end.

## V1 — The IC harness: does any score predict anything

*Cookbook Ch. 5 (Assessing market inefficiency based on volatility), Ch. 8
(Evaluating the information coefficient).* This is the milestone that makes
"challenge the data" a computation instead of a slogan.

- **V1-T1** Forward-return table. For every symbol in the universe, at bar
  horizons **1h, 4h, 12h, 1d, 3d, 7d**, store the realised forward return
  (`groupby(symbol).close.pct_change(t).shift(-t)`, the book's two-loop
  pattern). *DoD:* new table + migration; backfilled over available klines;
  a pure test proves no lookahead (the forward return at time *t* uses only
  bars strictly after *t*).
- **V1-T2** Score snapshot table. Every score the product renders is written
  at the moment it is rendered, with its inputs' timestamps. Sources: quant
  confidence, derivatives regime/crowding/squeeze, catalyst impact, sentiment,
  opportunity rank. *DoD:* one row per (score, symbol, observed_at); no score
  reconstructed after the fact — this is a live record, not a replay.
- **V1-T3** IC computation. Spearman rank correlation of score vs forward
  return, per score × horizon × day. *DoD:* pure module; `scipy.stats.spearmanr`
  or an equivalent rank implementation; unit-tested against a hand-computed
  fixture.
- **V1-T4** IC statistics + decay. Per score × horizon: mean IC, std, **risk-
  adjusted IC** (mean/std), t-stat, p-value, n. Plus the decay curve across
  horizons. *DoD:* matches the book's `plot_information_table` field set;
  API `GET /api/v1/evidence/ic`.
- **V1-T5** The render gate (EDR 0024 Decision 3). A score renders a digit only
  at `n ≥ 100`, `p ≤ 0.05`, at a horizon where IC has not decayed out. Below
  the gate: text only, with the reason. *DoD:* one shared gate function; every
  numeric render site routed through it; a test that asserts an ungated score
  cannot reach a digit.
- **V1-T6** "Why might this be wrong" panel on the verdict. Shows the verdict's
  own IC record, the horizon it is honest at, and the strongest current
  counter-evidence. *DoD:* rendered on `/` and the token page; reads only
  V1-T4's API.

**Exit criteria:** for each rendered score we can state, from data, either
"this predicts at horizon X with risk-adjusted IC Y" or "this has never been
shown to predict anything." No third answer.

## V2 — Beyond-chart statistics

*Cookbook Ch. 5 (PCA latent return drivers; hedging beta with linear
regression; Parkinson volatility).* Everything here ships **behind V1's gate**
— a new statistic gets no digit until it has an IC record.

- **V2-T1** BTC-beta decomposition. Rolling beta of each asset to BTC, plus the
  residual (idiosyncratic) return. Product line: *"SOL +6.0% — 4.4% is BTC
  beta, 1.6% is its own."* Kills the largest class of bad alt trades: buying
  an alt for a move that was BTC's. *DoD:* pure module + tests; rendered on
  the token page and in the opportunities list.
- **V2-T2** Latent driver / one-bet detector. PCA over universe returns; PC1
  variance-explained is "how much of today is a single trade." *DoD:* daily
  pass; surfaced as a market-context class ("one bet" / "dispersed"), never a
  raw eigenvalue.
- **V2-T3** Concentration warning on the user's live book: marginal
  contribution to risk per position (the book's MCAR loop). Fires "your three
  positions are one bet" when PC1 loading dominates. *DoD:* computed only when
  the user holds ≥2 positions; a test with a synthetic perfectly-correlated
  book.
- **V2-T4** Parkinson volatility. High/low range estimator, z-scored per
  asset, alongside the existing close-to-close ATR%. Strictly more information
  from the same candles. *DoD:* pure function matching the book's formula;
  fixture test; feeds the volatility read and sizing input **as a display and
  candidate input only** — wiring it into a decision is a separate,
  version-bumping change.

## V3 — Verdict stability and the honest horizon

*Cookbook Ch. 8 (Evaluating factor turnover; factor rank autocorrelation).*
The repo asserts hysteresis as a design principle; this measures whether it
works.

- **V3-T1** Rank autocorrelation of the ranking the product shows: daily
  Spearman correlation of today's ranks against yesterday's. *DoD:* series
  stored; low autocorrelation surfaces as "this list changes its mind daily."
- **V3-T2** Quantile turnover: share of the top quantile that was not in the
  top quantile last period. *DoD:* per-period series; the book's
  `quantile_turnover` semantics.
- **V3-T3** Churn cost statement. Turnover × realistic taker cost = what
  following the list costs before it earns anything. *DoD:* rendered next to
  the list; states the fee assumption inline.
- **V3-T4** Declare the honest horizon per verdict class from V1's IC decay,
  and make the UI say it ("this read is good for hours, not days"). *DoD:*
  horizon comes from the IC record, never from a hand-set constant.

## V4 — Risk watch on the live book

*Cookbook Ch. 12 (Calculating real-time key performance and risk indicators),
Ch. 13 (Triggering real-time risk limit alerts).* The arq worker already runs
a 5-minute cron and the SSE/Telegram delivery path already exists — this is
the book's `watch_cvar` on infrastructure that is already standing.

- **V4-T1** Returns series for the live book: periodic snapshot of unrealised
  PnL → percentage-change series. *DoD:* stored per user; the book's
  `get_streaming_returns` shape, on the cron rather than a thread.
- **V4-T2** Risk indicators: cumulative return, rolling volatility (sample
  std, **not annualised** — the book's explicit warning for intraday series),
  max drawdown, Omega, Sharpe, and conditional VaR in both percent and
  account currency. *DoD:* pure module; fixture tests; `GET /api/v1/risk/live`.
- **V4-T3** Threshold alerts. CVaR and drawdown limits, user-set, delivered
  through the existing notification stream, respecting quiet hours. *DoD:* an
  alert fires once per breach, not per tick; a test proves no alert storm.
- **V4-T4** Drawdown forensics: top-10 drawdown table (amount, peak, valley,
  recovery, duration) and the underwater series. *DoD:* rendered on `/book`.

## V5 — Journal forensics, the standard set

*Cookbook Ch. 9 (Breaking down strategy performance to trade level).* The
review plane has pieces of this; V5 makes it the complete, named set. Stays
inside the measurement boundary of EDR 0023 — measurement, never replay.

- **V5-T1** Round-trip extraction from the user's fills (open + close of the
  same quantity in the same symbol), with PnL, return, and duration.
- **V5-T2** The standard statistics: percent profitable, winning/losing count,
  **profit factor** (sum of wins ÷ |sum of losses|), average win, average loss,
  holding-period distribution — aggregate, per symbol, and per setup class.
- **V5-T3** Round-trip lifetime plot: holding period per position over time.
  Makes "I hold losers longer than winners" visible instead of arguable.
- **V5-T4** Behaviour verdict wired to V1's gate: a habit claim renders only
  when its own sample clears the evidence threshold.

*DoD for V5:* every statistic has a formula entry in
`docs/forensics-definitions.md` with its version bumped, per EDR 0023.

## V6 — One screen, one tier

Goal: the quick decision happens without opening a second source — including
without the product opening a second server.

- **V6-T1** Migrate every `frontend/src/routes/api/*` route to `/api/v1` or
  delete it with its caller. *DoD:* the Caddyfile's legacy-route comment is
  deleted because the legacy routes are.
- **V6-T2** Delete `frontend/src/server/` (second Postgres client, second auth
  store, four watcher loops). *DoD:* the client bundle has no `postgres`
  import path; auth is FastAPI's only.
- **V6-T3** Delete `frontend/src/lib/engine/` (~19.8k lines duplicating
  `engine/smc/`). *DoD:* no TypeScript re-implementation of a scored quantity
  remains; live views read the API.
- **V6-T4** Stop and disable `market-pulse.service` (port 3002); Caddy serves
  the static build and proxies only FastAPI. *DoD:* `iq.heydewi.com` fully
  functional with 3002 down.
- **V6-T5** The one screen. `/` answers, top to bottom: what the market is
  doing (READ) → the verdict (VERDICT) → why it might be wrong plus its IC
  record (CHALLENGE) → what a planned trade looks like and what it risks
  (DISCIPLINE). Everything else is a drill-down. *DoD:* the four jobs are
  answerable without a second route or a second tab.

---

## Taken from the cookbook, and deliberately not taken

**Taken:** Information Coefficient and IC decay (Ch. 5, 8); factor rank
autocorrelation and quantile turnover (Ch. 8); PCA latent drivers, beta
regression, marginal contribution to risk (Ch. 5); Parkinson volatility
(Ch. 5); walk-forward splits with a one-sided in-sample-vs-out-of-sample
t-test as overfit evidence (Ch. 6) — adopted as the statistic for the existing
pre-registered spike protocol, so no parameter is ever tuned on the whole
history; round-trip trade statistics and drawdown analysis (Ch. 9); real-time
risk indicators and threshold alerting (Ch. 12, 13); and the composite-metric
rule that opens Ch. 9.

**Not taken:** Interactive Brokers / TWS (Ch. 10–11) — wrong venue, and EDR
0024 Decision 4 removes order transmission anyway; Zipline Reloaded bundles
(Ch. 7) — US equity calendars, no crypto path; options and implied-volatility
surfaces (Ch. 3, 12) and ThetaData (Ch. 13) — no options product; Fama-French
factors (Ch. 5) — equity factor set, no crypto analogue; ArcticDB / HDF5
(Ch. 4, 13) — Postgres is sufficient at this data volume and is already the
polyglot seam.
