# Plan — Make Market Pulse Usable, Better, and Genuinely Insightful

Goal: turn a rich-but-sprawling analysis stack into a tool a real trader opens
every day because it tells them, clearly, **whether to trade and why** — and
stops them when they shouldn't. No new engine semantics required; this is about
clarity, trust, and the last mile from data to decision.

---

## Where we are

- Strong foundations: SMC engine (2.0.0, forward-tested), 6 dashboard planes,
  per-token analysis, trade review sync (Binance), tracker, news/calendar
  context, BYOK AI, and a live-execution plane in progress (permit + risk gate).
- The gap is **not more signals** — it's that value is scattered across many
  pages, the "so what" is buried, and a new user can't tell what to do first.

---

## Guiding principle

Every screen must answer one of three questions, out loud:
1. **Should I trade right now?** (regime / conditions)
2. **Is *this* trade good?** (setup quality + risk)
3. **Am I trading well over time?** (behavior review)

If a screen doesn't clearly serve one of those, it's decoration.

---

## Phase 1 — Usable (make it obvious, reduce friction)

- **One "Today" home.** Replace the raw snapshot landing with a decision-first
  view: market regime verdict (trade / caution / sit out), top 3 actionable
  setups, open-trade status, and any behavior warning — above the fold.
- **Onboarding path.** First-run tells the user the 3 things the app does and
  where to start. No dead-end empty states.
- **Plain-language verdicts everywhere.** Every score/badge gets a one-line
  "what this means" and "what would flip it." Kill lonely numbers.
- **Consolidate the 6 dashboard planes** into tabs under one "Markets" view so
  people stop navigating a menu of jargon (regime/rotation/technical/…).
- **Mobile pass.** It's mobile-first by design — audit every primary flow on a
  phone and fix the ones that aren't thumb-usable.

## Phase 2 — Better insight (raise signal quality, earn trust)

- **Trade / No-Trade verdict as a first-class object.** Per token and
  per-objective (scalp/intraday/swing), always stating: not-yet / wrong-strategy
  / what-flips-it. This already exists in the engine — surface it as *the*
  headline, not a sub-card.
- **Confidence you can audit.** Show the Trade Quality Score with its component
  breakdown (R:R, stop validity, regime fit, liquidity, behavior flags). Never a
  black-box "AI is 82% sure." Label it evaluation, not prediction.
- **Context that changes the call.** Fold news, unlock calendar, and volatility
  into the verdict itself ("swing setup valid, but token unlock in 2 days —
  size down"), not a separate feed the user has to cross-reference.
- **Show the track record.** Forward-test stats (2.0.0) visible on each verdict
  type so users see the engine is being kept honest, not just asserting.

## Phase 3 — Awesome (the "why not to trade" edge)

- **The Skip Check.** Before any entry: a deterministic pre-trade gate that can
  say *don't*. Bad R:R, wrong regime, over-exposed, revenge-trade pattern —
  stated plainly with the reason. This is the differentiator: most tools push
  you to trade; this one protects you from yourself.
- **Behavior mirror.** From synced trades: your best/worst hours, style-fit,
  overtrading and tilt patterns — turned into 1–2 concrete habits to change.
- **AI as Chief Risk Officer, not signal source.** It narrates, cross-examines,
  and explains rejections — never originates entries. Keep that boundary loud.
- **Execution loop closed (when M9 lands).** Verdict → permit → constitution
  check → confirmed order with mandatory stop → auto-journaled → reviewed. One
  honest, gated path from insight to action to accountability.

---

## What to explicitly NOT do

- No auto-trading, no AI-originated signals, no black-box confidence numbers.
- No new dashboard pages — consolidate, don't multiply.
- No engine decision/trigger changes for cosmetics (would reset the evidence
  clock; see engine change discipline).

---

## Rough sequencing

1. **Now:** Phase 1 home + verdict-first framing (highest usability payoff,
   zero engine risk).
2. **Next:** Phase 2 verdict surfacing + auditable scores + context folding.
3. **Then:** Phase 3 Skip Check + behavior mirror; execution loop as M9 ships.

Success = a user can open the app, get a straight answer on whether to trade,
know why, and trust that it'll tell them to sit on their hands when that's the
right call.

---

# ETL Plan — Token Events, News, Context → Trading Decisions

Goal: stop treating events/news as a separate feed to skim. Ingest them,
normalize into typed catalysts, score their trade impact, and **inject them into
the verdict itself** so the app can say "setup is valid, but X — size down / wait
/ skip."

## Where we are

Arq 5-min cron worker (`backend/app/worker/`) already runs typed passes:
- `event_pass` — pulls news sources, `classify_token_events` → typed `token_event`
  rows, owner-scoped alerts.
- `unlock_pass` — DeFiLlama token unlocks (keyless), auto-tracks opened tokens,
  gecko_id slug resolver.
- `context_pass` — global market breadth ingestion.
- Sync passes (Binance/Bybit trade + review).
- Presentation exists: chart event overlay (red/neutral/green markers + strip),
  external-context/catalyst prompt layer for the AI.

Gap: events are ingested and *plotted*, but not yet **scored for impact** or
**wired into the trade/no-trade verdict** as a first-class input. They inform the
human eye and the AI prompt, not the deterministic decision.

## Target pipeline (Source → Decision)

```
SOURCES → EXTRACT → NORMALIZE → CLASSIFY → SCORE → STORE → SERVE → CORRELATE
```

1. **Sources (extract).** Keep it keyless/free-first, add gated later:
   - News: Cointelegraph RSS (live) + more RSS/keyword feeds.
   - Unlocks: DeFiLlama (live).
   - On-chain / listing / funding-rate / OI catalysts (later, gated APIs).
   - Macro/TradFi calendar (later — Binance carries TradFi tickers).
   Each source is one pass, isolated, added without touching the classifier.

2. **Normalize.** Every item → a common `catalyst` shape regardless of source:
   `token(s)`, `type`, `event_time`, `direction`, `source`, `confidence`,
   `raw_ref`. Time is the join key to price.

3. **Classify (typed).** Extend `classify_token_events`: event **type**
   (unlock / listing / hack / regulatory / partnership / funding / macro),
   affected symbols, and a **direction** (bullish / bearish / neutral). Unlock =
   bearish-by-default is a visual call today; make direction explicit per type.

4. **Score — the new layer.** Deterministic **Catalyst Impact Score** per event:
   magnitude (e.g. unlock % of circulating supply), proximity (hours until /
   since), source confidence, and historical reaction if available. Output a
   compact `impact` (low/med/high) + `direction` the engine can consume. Rules,
   not LLM — same discipline as the Trade Quality Score.

5. **Store.** Typed `token_event` / `catalyst` tables as system of record
   (Postgres, the polyglot seam). Provenance-stamped like forward-test records:
   source, ingested_at, classifier version. Never overwrite; append + supersede.

6. **Serve.** One read model, three consumers: chart overlay (have it), the
   token verdict card, and the "Today" home catalyst rail.

## Presentation — where events show up

- **On the verdict, not beside it.** Token page verdict gains a catalyst line:
  "⚠ Unlock in 32h (4.1% supply) — bearish pressure; swing entries size down."
  The event modifies the headline call, not a footnote.
- **"Today" home rail.** Upcoming high-impact catalysts across tracked tokens,
  ranked by impact × proximity, each linking to its token verdict.
- **Chart overlay (keep).** Markers stay; clicking one shows the impact score
  and direction, not just the headline.
- **Alerts (keep, upgrade).** Owner-scoped alerts fire on **high-impact** events
  only — kill roundup-headline noise (known follow-up) by gating on impact score.

## Correlation with the trading decision

This is the payoff. Three degrees, in order of ambition:

1. **Gate input (deterministic).** The Skip Check reads active catalysts for the
   symbol. High-impact catalyst against the trade direction within its window →
   a stated caution or size-down in the pre-trade gate. Never silent.
2. **Verdict modifier.** Per-objective verdicts (scalp/intraday/swing) already
   say what-flips-it; a near-term catalyst becomes one of those flip conditions
   explicitly ("valid until the 14:00 CPI print").
3. **Backtest the catalysts themselves.** Because events are timestamped and
   stored with provenance, forward-test how price actually moved after each event
   type. Over time this turns "unlock = bearish (assumed)" into "unlock of >3%
   supply moved price −X% median over 48h (n=…)" — evidence, not folklore. This
   is the long-term moat and mirrors the engine's forward-test discipline.

## Sequencing

1. **Now:** add the Catalyst Impact Score (deterministic) + explicit per-type
   direction. Pure scoring over existing `token_event` rows, no new sources.
2. **Next:** wire impact into the token verdict card + "Today" rail; gate alerts
   on impact to kill noise.
3. **Then:** feed catalysts into the Skip Check / verdict flip-conditions.
4. **Later:** new sources (listings, funding/OI, macro calendar) + the
   event-reaction backtest that validates the impact model itself.

## Not-do

- No LLM in the ingest/score path — classification and impact are deterministic
  and versioned; the AI only narrates the result.
- No new event *pages* — events live inside the verdict and one home rail.
- Don't present a catalyst as a signal on its own; it modifies a setup, never
  originates one (consistent with the AI-never-originates stance).
