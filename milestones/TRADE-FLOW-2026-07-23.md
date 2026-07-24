# Trade flow redesign + execution/engine latency audit — 2026-07-23

**Status:** proposed; companion to `ROADMAP-2026-07-23.md` (amends R3) and
`IA-REDESIGN-2026-07-23.md` §4.2 (the Check/ticket surface this specifies).
**Scope:** execution-plane UX + correctness. No engine decision/trigger
semantics; every new rule lives in the risk engine / order service planes.
Audit findings below are from reading the shipped code
(`backend/app/execution/`), not the plan docs.

---

## 1. Audit — leverage & margin (correctness)

### F1 — The exchange never receives the judged leverage or margin mode. **Critical.**
`binance_client.py` implements orders, algo orders, account reads — but has
**no `POST /fapi/v1/leverage` and no `POST /fapi/v1/marginType`**. Nothing in
`order_service.py` sets either before entry. The permit judges
`proposal.leverage` (constitution max-leverage check, sizing's margin +
liquidation estimate) — then the order executes at **whatever leverage and
margin mode the symbol last had on the account**. Every permit's margin,
effective-leverage, and liquidation numbers are potentially fiction about
the position that actually opens.
**Fix (R3, before any further execution work):** add both endpoints to the
client; order service sets margin mode + leverage per the permit *before*
entry submit, reads back `positionRisk` to confirm, and **aborts if the
exchange rejects the change** (e.g. existing position in the other mode).
Divergence = hard stop, never a warning.

### F2 — No liquidation-vs-stop check. **Critical once leverage is user-picked.**
`risk_engine.py` runs 12 checks (risk band, loss limits, max leverage,
concurrency, correlation, R:R, stop-missing, symbol/session, staleness,
cooldown) — **none compares the liquidation price to the stop**. At high
leverage the liquidation price can sit *inside* the stop: the exchange
liquidates before the stop ever fires, and the "mandatory stop" invariant
is silently void. Sizing already computes `liquidation_price`; the check is
cheap.
**Fix:** new hard check `LIQUIDATION_INSIDE_STOP`: liquidation must be at
least a configured buffer (default 20% of stop distance) *beyond* the stop,
else `REJECTED` with the reason and the max leverage that would pass.

### F3 — Liquidation model is isolated-only, flat-MMR, and unlabeled.
`sizing.py` uses the simplified isolated formula with a flat 0.005
maintenance-margin rate (comment admits: ignores funding, fees, tiered
brackets) and has **no cross-margin model at all**. Acceptable as an
estimate — dangerous as an unlabeled number the F2 check would rely on.
**Fix:** (a) tiered maintenance brackets from `exchangeInfo` leverage
brackets (deterministic, fetchable); (b) isolated: keep the per-position
estimate; cross: the honest statement is "backed by full account balance —
liquidation depends on total account state", so the F2 check runs against
the **conservative isolated-equivalent** price and the UI labels the cross
estimate as conservative; (c) every liquidation render carries "estimate"
labeling (M0 honesty rules).

### F4 — No entry-price drift guard at consume time.
Permit TTL is 90 s (`PERMIT_TTL_SECONDS`). Within that window price can
move materially; `consume_permit_for_execution` verifies proposal-field
integrity (mismatch detection) but never re-checks the market. A market
entry can fill far from the price the stop distance / R:R / sizing were
judged at — the permit's risk numbers no longer describe the trade.
**Fix:** at consume, fetch mark price; if drift from proposal entry exceeds
a bound (default: 25% of stop distance), reject consumption with
`ENTRY_DRIFT` — user re-checks in one tap (flow §3 makes that cheap).

### F5 — Ticket UI has no leverage or margin-mode input.
`trade-ticket.tsx`: stop price + risk% slider only. Consistent with Phase A
scope, but it means today's permits all carry an implicit leverage the user
never chose — and F1 means the exchange ignores even that. The flow in §3
makes both first-class user choices.

## 2. Audit — the delay (decision → protected position)

Measured from code paths; timings are structural, not benchmarked.

| Stage | Path | Latency | Notes |
|---|---|---|---|
| Verdict freshness | `MarketSnapshot` server cache | ≤ 45 s stale (`SNAPSHOT_TTL_MS`) | By design; live WS overlays prices in real time. Fine for context, stated on the permit? No — nothing stamps snapshot age today. Minor: include context age in permit snapshot. |
| Engine verdict cadence | closed-bar evaluation + hysteresis | bar-close granularity | Deliberate (anti-noise); not a latency bug. Skip Check reads it live per request. |
| Forward-test / catalyst ingestion | arq cron | 5-min tick | Catalyst rail can lag a breaking event by up to ~5 min + source lag. Acceptable; display ingestion timestamp. |
| Permit request | account state (cached, `ACCOUNT_STATE_MAX_AGE_SECONDS`, stale-fail-closed via `STALE_ACCOUNT_STATE`) + pure risk engine | 1 REST worst case, else ms | Fail-closed verified in code. ≤ 2 s budget holds. |
| Permit validity | TTL | 90 s | Paired with F4 drift guard this is sound; without it, 90 s is the exposure window. |
| Entry submit | 1 REST, `ORDER_TIMEOUT_SECONDS` = 10 s | ~0.2–1 s typical | Idempotency keys + resume path exist — good. |
| Fill confirm (market) | poll ≤ 5 × 0.4 s | ≤ 2 s, then `RECONCILIATION_REQUIRED` (resumable, never guessed) | Sound design. |
| **Unprotected window** | entry-confirmed → SL algo order confirmed | **~0.3–1 s typical; up to ~10 s on SL timeout, then auto-flatten** | The critical window. Sequential and non-atomic by exchange design (no futures entry+SL atomicity on Binance). |
| TP placement | after SL | +1 REST | Correct ordering (SL before TP); TP failure downgrades to `TP_FAILED`, position stays stop-protected. |

**Verdict on the delay:** the architecture is right (SL-first, flatten on
failure, resumable reconciliation). Three tightenings:

- **D1:** per-leg timeouts — keep 10 s for entry, drop the **SL leg** to
  ~3 s with one immediate retry before flatten; shrinks the worst-case
  unprotected window from ~10 s to ~6 s without more risk.
- **D2:** stamp `snapshot_age` + `mark_price_at_consume` into the
  execution record — makes every delay measurable in production instead
  of structural-only (feeds the R6 reconciliation pass).
- **D3:** F4's drift guard converts the 90 s TTL from an exposure window
  into a bounded one.

## 3. The redesigned ticket — one surface, two depths

Design constraints kept from EDR 0020: the user **never enters a
quantity**; sizing derives from balance, stop distance, risk%; permits
gate everything; no AI in the decision path. New (this doc, owner
sign-off = EDR 0020 amendment): **leverage and margin mode are explicit
user choices** feeding sizing and the F1 sync path — they change *how*
the risk is carried, never *how much* is risked.

### 3.1 The max-risk-at-leverage rule (deterministic)

Leverage caps notional: `max_notional = balance × leverage` (minus
existing margin in use). With stop distance `d` (fraction of entry),
**max achievable risk at this leverage = max_notional × d / balance**.
The ticket always shows the live triple:

> Risk: **1.5%** ($45) · Max at 3×/isolated with this stop: **2.4%** ·
> Liq: $58,410 — **1.8× stop distance beyond your stop** ✓

Rules: requested risk% ≤ achievable → position sized normally, leverage
only sets margin efficiency. Requested > achievable → ticket **caps to
achievable, says so** ("2% requested, 1.6% possible at 2× — raise
leverage or widen risk band"), and the permit records the cap. Liquidation
inside the F2 buffer → the leverage chip that caused it shows the
rejection inline *before* permit request — the user is steered, not
slapped.

### 3.2 One screen, three zones (no wizard, no page transitions)

**Zone 1 — Trade.** Symbol (pre-filled from the token/Check context),
side, entry (market / limit at POI-plan price when one exists), **stop**
(pre-filled from the engine's plan when evidenced; drag-adjustable on the
inline mini-chart), target (pre-filled from plan; optional).

**Zone 2 — Risk.** 
- Risk% slider bound to the constitution band (0.5–3%).
- **Leverage chips:** 1× · 2× · 3× · 5× · 10× · custom — capped at
  constitution `max_leverage`; chips beyond the F2-safe bound render
  disabled with "liq would sit inside your stop".
- **Margin mode toggle:** Isolated / Cross. **Default isolated** —
  contained blast radius is the beginner-correct default; one-line
  explainer under each ("Isolated: only this position's margin at risk ·
  Cross: whole account backs the position — liquidation estimate is
  conservative"). If the symbol has an open position in the other mode,
  the toggle locks to the open position's mode with the reason (exchange
  constraint).
- Live-computed line (read-only, recomputed on every input): qty,
  notional, required margin, effective leverage, liq price + distance
  vs stop, and the §3.1 max-risk triple.

**Zone 3 — Permit + confirm.** Permit auto-requested (debounced ~500 ms)
whenever inputs are valid — no "get permit" button. Card renders inline:
TQS with components, per-check results, decision. `APPROVED` → single
**Confirm** button with TTL countdown ring; `REJECTED` → reasons, each
with its steer ("reduce leverage to ≤5×", "risk band allows 1.6% max
here"). Confirm → entry → live status strip (submitted → filled →
**protected**) driven by the existing execution-record events — the user
watches the stop attach, which is the trust moment.

### 3.3 Two depths, same screen

- **Simple (default, and always the mobile default):** Zones collapse to
  — symbol/side/stop (pre-filled from plan), risk% at constitution
  default, leverage default **3× isolated** (owner-configurable in the
  constitution), everything else behind one "Adjust" disclosure. A
  beginner ships a fully-guarded trade in: pick side → glance stop →
  Confirm. Two decisions, both theirs.
- **Pro:** "Adjust" open persists (stored pref); all Zone-2 controls
  visible, keyboard navigable, no extra confirmations beyond the one
  Confirm. Pros get speed by density, beginners by defaults —
  no separate modes to build or maintain.

Both depths run the identical permit path — simplicity is presentation,
never a weaker gate.

### 3.4 Where it lives

Exactly the IA doc's `/check` continuation: Check answer → "Build
ticket" expands Zones 1–3 in place; token-page verdict header and Today's
setup cards deep-link into it with context pre-filled. Standalone
`/check` handles the blank-slate case. One surface everywhere.

## 4. Task additions (amend roadmap R3)

Ordered; each with the M9 test discipline (fixtures + negative tests,
testnet-verified):

1. **R3-F1** Leverage/margin-mode sync: client endpoints, set-before-entry,
   read-back confirm, abort-on-divergence. *Blocks everything below.*
2. **R3-F2** `LIQUIDATION_INSIDE_STOP` hard check + per-chip pre-flight in
   the ticket.
3. **R3-F3** Tiered-bracket liquidation estimate; cross-margin conservative
   model + labeling.
4. **R3-F4** `ENTRY_DRIFT` consume-time guard.
5. **R3-D1/D2** SL-leg timeout tightening + latency stamps.
6. **R3-UX** The §3 ticket (frontend) replacing `trade-ticket.tsx`;
   constitution gains `default_leverage` + `default_margin_mode`.
7. **EDR 0020 amendment** recording: leverage/margin-mode as user inputs,
   the max-risk-at-leverage rule, F2 buffer, drift bound. Owner sign-off.

Agent fit (per roadmap matrix): F1–F4 + EDR = **Opus** (money-path
invariants); ticket UI = **Sonnet** against this spec; check-matrix and
label sweeps = **Haiku / Gemini 3.1 Flash**.

## 5. What stays forbidden

No quantity input anywhere. No leverage suggestion from AI. No
cross-margin default. No permit bypass at any depth. No mainnet until
U24 — everything above is testnet-provable first.
