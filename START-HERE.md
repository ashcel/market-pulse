# Start Here — The First Move

Three docs describe the destination (`plan.md`), the context engine that feeds it
(ETL section), and who it's for (`discretionary-trader.md`). This one picks the
**single first thing to build** so it doesn't stay a plan.

---

## The pick: a verdict-first "Today" home

Why this first, over everything else:
- **Highest usability payoff.** It's the screen the trader opens every session;
  today it's a 761-line market snapshot that makes them synthesize 50 tickers
  themselves. Fixing it is felt immediately.
- **Zero engine risk.** No decision/trigger changes, no `ENGINE_VERSION` bump,
  no forward-test clock reset. Pure presentation over data that already exists.
- **Reuses what's built.** The per-objective verdict engine already exists
  (`intent.ts` → `assessIntent` → `useReconciledAssessments`, live on the token
  page). This move surfaces it on the home, it doesn't invent it.

## What "done" looks like

The home answers question #1 — *"is today a day to trade?"* — above the fold:

1. **Regime verdict in words.** One line: risk-on / caution / sit-out, plus the
   one-sentence why. Derived from the existing `MarketSnapshot` regime, just
   stated as a call instead of gauges.
2. **Top 2–3 actionable setups.** Not 50 tickers — the few tokens whose verdict
   is actually live, each as a card: symbol, style (scalp/intraday/swing), the
   verdict, and what-flips-it. Links to the token page.
3. **Open-trade + behavior strip.** If there are open trades, their status; if
   there's a behavior warning from synced trades, it shows here.
4. **Catalyst rail.** Upcoming high-impact events across tracked tokens (from the
   ETL plan), ranked by impact × proximity.

Everything below the fold stays — the 6 planes become tabs later. This move is
purely about what greets the trader in the first 2 seconds.

## Deliberately NOT in the first move

- No Skip Check yet (that's the deeper Phase 3 build; needs the execution plane).
- No Catalyst Impact Score yet — the rail can start with raw proximity/type and
  gain scoring next. Don't block the home on the ETL scoring layer.
- No engine changes. If a "verdict" needs new engine logic, it's out of scope —
  surface only what `assessIntent` already returns.

---

## What already exists (don't rebuild)

| Need | Status | Where |
|---|---|---|
| Per-objective verdict (not-yet / wrong-strategy / what-flips-it) | Built | `lib/engine/intent.ts`, `hooks/useReconciledAssessments.ts` |
| Market regime / snapshot | Built | `lib/engine/market.ts`, `hooks/queries` |
| Forward-test track record (2.0.0) | Built | `backend/app/worker/`, `/api/forward-test` |
| Event ingestion + chart overlay | Built | `backend/app/worker/event_pass.py`, chart overlay |
| Unlock calendar | Built | `backend/app/worker/unlock_pass.py` (DeFiLlama) |
| Trade review + behavior analytics | Built | `app/binance_review/`, review route |
| Execution permit + risk gate | In progress (M9) | `backend/app/execution/` |
| Catalyst **impact scoring** | **Missing** | ETL plan, step 4 |
| Verdict-first **home** | **Missing** | this doc |
| **Skip Check** (deterministic don't-trade gate) | **Missing** | plan Phase 3 |

The pattern: the hard parts (verdict engine, ingestion, forward-test, review) are
already built. The missing pieces are almost all **presentation and wiring** —
connecting existing outputs into a decision the trader can act on in seconds.
That's the good news: the moat exists, it's just not surfaced.

---

## Order of moves after this one

1. **Verdict-first home** ← start here.
2. Consolidate the 6 dashboard planes into tabs under one Markets view.
3. Catalyst Impact Score + wire catalysts onto the token verdict card.
4. Skip Check (deterministic pre-trade gate) as the execution plane matures.
5. Event-reaction backtest — validate the impact model with real forward data.

Each move is independently shippable and none resets the engine clock. Ship #1,
feel the difference, then decide if the order still holds.
