# Home Layout Spec — Verdict-First "Today"

Concrete spec for the first move (`START-HERE.md`). Data-grounded: every section
maps to a field that already exists. No engine changes.

---

## Layout (mobile-first, single column)

```
┌─────────────────────────────────────────┐
│  TODAY            BTC $— · updated 12s    │  ← header: live price + freshness
├─────────────────────────────────────────┤
│                                           │
│   ▓ CAUTION — trade small                 │  ← 1. REGIME VERDICT (hero)
│   Range-bound, low conviction. BTC daily  │
│   structure choppy; breadth 42%.          │
│   Skip breakouts. Half size on reversions.│
│                                           │
├─────────────────────────────────────────┤
│  LIVE SETUPS                    see all → │  ← 2. ACTIONABLE SETUPS
│  ┌───────────────────────────────────┐   │
│  │ SOL · intraday      ● WATCHING     │   │
│  │ Reclaim of 172 pivot. Flips long   │   │
│  │ on H1 close > 174.  R:R 2.4        │   │
│  ├───────────────────────────────────┤   │
│  │ ETH · swing         ● NOT YET      │   │
│  │ Needs H4 CHoCH. Wrong strategy for │   │
│  │ scalp right now.                   │   │
│  └───────────────────────────────────┘   │
├─────────────────────────────────────────┤
│  YOUR TRADES                              │  ← 3. OPEN + BEHAVIOR STRIP
│  2 open · +1.2R unrealized                │
│  ⚠ 3rd trade in 40min — overtrade watch   │
├─────────────────────────────────────────┤
│  WHAT'S COMING                            │  ← 4. CATALYST RAIL
│  ⚠ ARB unlock · 32h · 4.1% supply         │
│    CPI print · tomorrow 13:30             │
├─────────────────────────────────────────┤
│  … existing snapshot sections (collapsed) │  ← everything else, below fold
└─────────────────────────────────────────┘
```

---

## Section by section

### Header
- **BTC live price + "updated Ns ago"** — from Binance WS feed (`binance-live-feed`)
  and `MarketSnapshot.updatedAt`. Freshness dot: green < 60s, amber < 5m, red +.
- If `source: "demo"`, show a "demo data" tag (existing convention).

### 1. Regime verdict (the hero — biggest element on screen)
- **Source:** `MarketSnapshot.regime` — already has `regime` (Risk On / Neutral /
  Risk Off) and a `description` sentence. Add a **one-line action** derived from
  the same call (a lookup table, not new engine logic):
  - Risk On → "Conditions favorable — trade your plan, normal size."
  - Neutral → "Mixed — be selective, reduce size, skip low-conviction setups."
  - Risk Off → "Poor conditions — sit out or scalp only, tight risk."
- **Color:** green / amber / red band. This is the single loudest thing on the
  page — it's question #1 answered before the user scrolls.
- **Inputs it can cite** (already computed): breadth %, BTC daily structure,
  vol score, Fear & Greed. Show 2–3 as small chips under the sentence.

### 2. Live setups (2–3 cards, not 50)
- **Source:** run `assessIntent` / `useReconciledAssessments` across tracked
  tokens; filter to the ones whose verdict is **actionable** (watching / live /
  about-to-flip), rank by proximity to trigger. Cap at 3.
- **Each card:** symbol · style (scalp/intraday/swing) · verdict badge · the
  **what-flips-it** line · R:R when a valid stop exists (else % + MAE/MFE, per
  EDR 0017). Tap → token page.
- **Empty state (important):** if nothing is actionable, say so plainly —
  "No live setups. That's a fine answer — wait for one." Never fabricate cards.

### 3. Your trades + behavior strip
- **Open trades:** from the tracker / execution plane — count + unrealized R (or
  % where no stop is evidenced).
- **Behavior warning:** from synced-trade analytics (`binance_review`) — fire
  only when a pattern is live (overtrade cadence, revenge sequence, oversized).
  One line, actionable. No warning = show nothing (don't nag).

### 4. Catalyst rail
- **Source:** `token_event` + `unlock_pass` rows for tracked tokens, forward
  window (next ~72h). Rank by impact × proximity (raw type/proximity until the
  Catalyst Impact Score lands, then by score).
- Each row: icon (⚠ high / neutral) · symbol · time-to-event · magnitude when
  known (unlock % supply). Tap → token page with the event highlighted.
- Alerts stay gated to high-impact only (kills roundup noise).

---

## States to design (not just the happy path)

| State | Behavior |
|---|---|
| Loading | Skeleton for each section; header price streams in first. |
| Demo data | "demo" tag in header + on any card sourced from mock candles. |
| No live setups | Explicit "no setups — waiting is valid" card (see §2). |
| No open trades | Hide the trades line; keep behavior strip if a pattern fires. |
| No catalysts in window | Hide the rail entirely; don't show an empty box. |
| Stale worker | If forward-test/ingest is stale, small amber notice (reuse the |
|              | existing `health-watch` SSE staleness signal). |

## Mobile rules
- Single column, thumb-reachable. Hero regime verdict fills the first viewport.
- Setup cards are full-width, tappable, no hover-dependent info.
- Below-fold snapshot sections collapse into accordions/tabs (the plane
  consolidation from `plan.md` Phase 1 — can land in the same pass or after).

## Explicitly out of scope for this screen
- No new engine outputs — surface only what `assessIntent` / snapshot return.
- No Catalyst Impact Score dependency — rail ships on raw proximity first.
- No Skip Check here — that lives at the point of order entry, not the home.

---

## Build notes
- New route content replaces the top of `routes/index.tsx`; existing sections
  move below the fold (or into the later tab consolidation).
- Everything reads from existing hooks: `useMarketSnapshot`,
  `useReconciledAssessments`, tracker/review queries, the events read model.
- Ship it, open it on a phone, and check: can I answer "trade today?" in 2
  seconds without scrolling? That's the acceptance test.
