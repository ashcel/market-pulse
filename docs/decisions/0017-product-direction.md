# EDR 0017: Product direction — decision journal + intelligence brief

- **Status:** Accepted (2026-07-15) — direction commit from the 2026-07-14 product audit; implementation lands through the `milestones/` M0–M8 plan, which cites this EDR as its anchor.
- **Scope:** product-plane only — what Market Pulse _is_, how engine output may be presented, when R-multiples may be displayed, where exchange API keys live, and how TradFi markets enter. **No engine decision/trigger semantics change and no `ENGINE_VERSION` change** — the frozen 1.0.0 forward-test clock keeps running untouched.
- **Depends on:** `research/verdict-protocol-1.0.0.md` (frozen 2026-07-12 — the no-peeking rules and the n ≥ 150 verdict gate this EDR defers to); `milestones/README.md` (the plan that executes these decisions).

## Problem

The 2026-07-14 audit found the product claiming what its evidence doesn't support. The homepage framed engine calls as "Actionable Setups" and "Today's Edge" while the 1.0.0 forward-test record is still accumulating toward its pre-registered verdict gate; user-facing numbers (confidence gauges, discovery scores, backtest win rates) carried no stated evidence basis; and without a committed direction, each new feature drifted the product toward signal-selling — a posture the record cannot justify and may never justify. The revamp needs one durable record of what the product is instead, because every later milestone (trade ingestion, context stamping, forensics, cohort analytics, skip check, TradFi) builds on these calls.

## The five decisions

### 1. Product scope — decision journal + intelligence brief + behavior review

Market Pulse is a **capital-at-risk decision journal wrapped in a market-intelligence brief, with a behavior-review layer over the user's actual trades**. It helps the user decide — including the decision to skip — and reviews what they actually did with honest metrics. It is **read-only forever**: it never executes or manages trades, and API-key scopes that could (trade, withdrawal) are rejected at intake (decision 4). AI is a **complement, not a source of truth**: BYOK, grounded only in data the system has persisted, and always labeled as AI-generated — it narrates and cross-examines the record, it does not originate signals.

### 2. Engine stance — context instrument, pending verdict

The deterministic engine (`src/lib/engine/`) is a **context instrument only** until its 1.0.0 forward-test record reaches the n ≥ 150 verdict gate and `research/verdict-protocol-1.0.0.md` §7–§9 is executed. Until then:

- No verdict, trigger, or setup output is presented as proven edge, anywhere in the UI or in AI-generated text. Framing is "engine read, forward test in progress" (M0-T3 executes the homepage reframe).
- Every user-facing number gets a definition and an evidence basis, or it is demoted/removed (M0-T4/T5's score inventory).
- The no-peeking rule stands: nothing outside `record:report --integrity` reads 1.0.0 outcomes before the gate. User-trade analytics (M1+) are a separate record and unrestricted.

### 3. R-normalization — R only where a stop is evidenced

R-multiples are shown **only where a stop order is evidenced in the record** (an actual stop order in the user's trade history, or a persisted stop in an engine record). Everywhere else the display is **% return plus MAE/MFE**. No synthetic or assumed stops for normalization — an R computed from an invented stop is fake precision about the user's own risk. Where a metric's minimum evidence isn't met, "insufficient evidence" renders as a first-class state, not a hidden row.

### 4. Key custody — server-side, encrypted, read-only-enforced

Exchange API keys are stored **server-side**, **AES-256-GCM encrypted at rest**, with the encryption key supplied by environment variable (`MARKET_PULSE_SECRET_KEY`) and never persisted. Plaintext never leaves the sync path: repo functions don't return it, logs redact it. **Read-only permission is enforced at the exchange API level** — on intake the key's permissions are checked against Binance and any key with trading or withdrawal enabled is rejected outright, not merely warned about. (M1-T2/T3 implement this.) This is deliberately the opposite custody model from the AI analyst keys, which stay in the browser (see decision rationale below).

### 5. TradFi — via Binance TradFi tickers, gated on the instrument survey

TradFi markets enter through **Binance's TradFi tickers**, not a separate broker or data-vendor integration — one venue, one key custody model, one kline pipeline. The entire TradFi milestone (M7) is **gated on M7-T1's instrument-semantics survey**: enumerate the tickers, measure gap/session structure empirically, and only then decide how much instrument-class abstraction the engine's reads need. No TradFi surface ships before that survey answers whether these instruments trade continuously.

## What was intentionally rejected

- **Signal-seller / auto-trader direction** — executing or managing trades, or selling engine calls as edge. Rejected on both evidence (the verdict gate hasn't been reached; the early 1.0.0 tape read bearish and the protocol forbids hot-patching around that) and blast radius (custody of trading-enabled keys).
- **Presenting engine output as edge with disclaimers** — a hedge caption under "Today's Edge" still sells the frame. The reframe is structural: brief first, engine reads labeled as instruments under test.
- **Uniform R-multiples via assumed stops** — normalizing every trade to R by synthesizing a stop where none existed manufactures precision about risk the user never defined.
- **Client-side custody of exchange keys (the AI-key model)** — the AI analyst's BYOK keys stay in the browser because only the browser calls the provider. Exchange keys can't follow that model: the server worker must sync trades autonomously, so the keys must live server-side — which is exactly why they are encrypted at rest and permission-gated to read-only.
- **A separate TradFi broker/data integration** — a second auth plane, custody model, and data pipeline for unproven demand; Binance's own TradFi tickers make the existing pipeline reusable.

## Validation performed

This is a direction EDR — the diff is documentation only (this file + the CLAUDE.md link). Full suite green via `bunx vitest run`, `bunx tsc --noEmit` clean, `bun run lint` clean; no engine, server, or client code touched. The measurable validation of each decision lives in the milestone DoDs that implement it: M0-T3/T4/T5 (framing + score honesty), M1-T2/T3 (custody + permission gate, incl. tamper-detection tests and a real trading-key rejection), M3 (R/MAE-MFE display rules), M7-T1 (instrument survey).

## Future extension points

1. **The 1.0.0 verdict gate** — when `record:report --integrity` shows n ≥ 150 matured primary-cohort records, the verdict protocol executes and its KEEP/EXTEND/INVESTIGATE/CHANGE outcome decides whether the engine graduates from context instrument; that outcome amends decision 2, not this EDR's other calls.
2. **M7-T10** — the TradFi extension gets its own EDR once the survey and instrument-class abstraction land.
3. **M5's pre-registered cohort protocol** — extends decision 3's evidence discipline from display rules to statistical claims (minimum n before any cohort statement).
