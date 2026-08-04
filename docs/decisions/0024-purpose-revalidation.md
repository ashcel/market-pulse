# EDR 0024: Purpose revalidation — the four jobs, and what gets cut

- **Status:** Accepted (2026-08-04) — owner signed off on Decision 4 (execution split): park the order-placement half on a branch, keep the pre-trade half on `main`.
- **Scope:** product scope and repo surface. **No engine decision/trigger semantics change and no `ENGINE_VERSION` change** — the 2.0.0 forward-test clock keeps running untouched. This EDR decides what the product is for and which code has no claim on that purpose.
- **Supersedes in part:** EDR 0017 (product direction) and EDR 0020 (live execution direction) — see Decision 4.
- **Companion:** `milestones/REVALIDATION-PLAN-2026-08-04.md` (V0–V6 plan), `research/PYTHON_FOR_ALGORITHMIC_TRADING_COOKBOOK.pdf` (methods source for V1–V5).

## Problem

The owner restated the purpose on 2026-08-04:

> Help the user understand the current market situation **beyond the chart** —
> connect the dots between statistics, available data, sentiment, and news.
> For a user who must make a **quick decision without opening multiple sources
> or watching multiple charts and indicators**. Making **planned and
> profitable** trades; avoiding **bad trades and bad management**. Reading the
> market, **giving a verdict, questioning the verdict, challenging the data.**

Measured against that, the repo has drifted. `app/execution/` is 7,669 lines —
the largest module by a factor of three — and it places orders. The one module
that questions a verdict, `app/scorecard/`, is 476 lines and has never
correlated a single score against a forward return. A dead exchange
integration (`app/bybit/`, 1,238 lines) is still in the tree. Two complete
server tiers, two databases clients, and two copies of the engine
(`engine/smc/` in Python, `frontend/src/lib/engine/` in TypeScript, ~19.8k
lines) are all live at once.

The product has been measured by what it can do, not by what it answers.

## The five decisions

### 1. The product answers four questions, in this order

Every surface must belong to one of these. Anything belonging to none is out
of scope.

| Job | Question | Owner modules |
| --- | --- | --- |
| **J1 READ** | What is the market actually doing, beyond price? | `market/`, `derivatives/`, `news_intel/`, `events/`, `opportunities/`, worker ingestion |
| **J2 VERDICT** | So what do I do, right now, on one screen? | `signals/`, `quant/`, `engine/smc/`, `forward_test/` |
| **J3 CHALLENGE** | Why might this be wrong, and has this call ever worked? | `scorecard/` + everything V1–V3 builds |
| **J4 DISCIPLINE** | Plan it, size it, don't manage it badly. | `review/`, `binance_review/`, the pre-trade half of `execution/` |

J3 is the differentiator and it is the thinnest thing in the repo. That
inversion is the finding of this audit.

### 2. `app/derivatives/`'s house rule becomes the repo-wide rendering rule

That module's docstring already states it: *"never expose a raw metric alone —
the API answers 'what does this imply'."* Chapter 9 of the cookbook states the
same thing from the risk side: *"no single risk or performance metric tells
the entire story."*

**Decision:** no numeric surface ships a bare number. Every rendered metric
carries a class (what band it is in), a direction (what it implies), and an
evidence state (how much we know). A metric that cannot supply all three is
rendered as text, or not rendered.

Rejected: keeping a "raw values" mode for power users. The stated purpose is
*avoiding* multiple sources and indicator-watching; a raw-numbers mode rebuilds
exactly the thing the product exists to replace.

### 3. A score that has not been correlated against forward returns may not
show a number

Adopted from the cookbook, Ch. 5 (*Assessing market inefficiency based on
volatility*) and Ch. 8 (*Evaluating the information coefficient*): the
Information Coefficient — the Spearman rank correlation between a score and
the forward return at a fixed horizon — is the standard test of whether a
score predicts anything, and its decay across horizons is what defines the
score's honest holding period.

**Decision:** every score the product renders (quant confidence, derivatives
regime, catalyst impact, sentiment, opportunity rank) must have an IC record
at each horizon it implies. Gate for rendering a number:

- `n ≥ 100` observations at that horizon, **and**
- `p ≤ 0.05` on the Spearman rank correlation, **and**
- the horizon shown is one where IC has not yet decayed to insignificance.

A score failing the gate is still computed and still ranks things — it renders
as descriptive text with no digits, and the UI says why. This makes
"challenging the data" mechanical instead of editorial.

Rejected: a soft "low confidence" badge on unproven numbers. The repo has
tried disclosure-by-tooltip (M0-T5a..d) and the number still gets read as
truth. Withholding the digit is the only disclosure that works.

### 4. Order placement is out of scope; the pre-trade half of `execution/` stays

`app/execution/` is two products glued together:

- **Pre-trade (keep):** the deterministic Trading Constitution, position
  sizing, liquidation-vs-stop checking, the Trade Permit, skip check. This is
  literally "planned trades / avoid bad trades / avoid bad management."
- **Order placement (cut):** exchange key custody, the order router, algo
  order plumbing, live position management. This is a brokerage feature. It
  is the largest attack surface and the largest maintenance burden in the
  repo, mainnet has been blocked on owner action U24 since 2026-07-19, and
  nothing in the restated purpose asks the product to *send* an order.

**Decision:** amend EDR 0020. The permit remains the
product's output; it becomes a plan the user executes on the exchange, not an
order IQ transmits. Testnet order code is parked on a branch, not deleted,
so the decision is reversible.

Rejected: keeping execution behind its existing default-off kill switch. The
code still has to be maintained, reviewed, and kept credential-safe whether or
not the switch is on. A flag does not reduce surface.

### 5. One tier, one engine, one system of record

The TypeScript engine and the `frontend/src/server/` tier were retained as a
web-serving layer at the 2026-07-17 Python cutover. They have since accreted
API routes, a second Postgres client, a second auth store, and four watcher
loops. Caddy currently splits traffic: `/api/v1/*` to FastAPI, everything else
to the legacy TanStack service on port 3002.

**Decision:** FastAPI + `engine/smc/` is the only server and the only engine.
The web tier becomes a static client. Every route under
`frontend/src/routes/api/` migrates to `/api/v1` or dies with its caller.

## Consequences

- **Cut now (no sign-off needed):** `app/bybit/` and `worker/bybit_sync_pass.py`
  (inert, superseded by `binance_review/`); the four redirect-stub routes
  (`rankings`/`regime`/`rotation`/`technical`); nav V1 once `NAV_V2` is on.
- **Cut after Decision 4 sign-off:** the order-placement half of `execution/`.
- **Cut across V6:** `frontend/src/lib/engine/`, `frontend/src/server/`, the
  port-3002 service.
- **Decide:** `app/quant/` and `app/tradeway/` are thin proxies to an external
  notifier-bot dashboard — a runtime dependency for a core read. Either flip
  `PORT_FORECAST=1` and finish the port, or drop the feature.
- The engine version does not move for any of this. V1–V3 are measurement
  planes; they read outcomes and never change what the engine decides. If a
  V2 statistic is later wired *into* a decision, that wiring is a separate,
  version-bumping change with its own pre-registered spike.
