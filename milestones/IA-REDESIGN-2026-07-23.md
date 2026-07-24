# Information architecture redesign — 2026-07-23

**Status:** proposed (owner sign-off with `ROADMAP-2026-07-23.md` — the two
documents are one decision). **Scope:** navigation, hierarchy, journeys,
screen structure. No engine semantics, no new data planes; this reorganizes
what exists and deletes what fails the decision test.

---

## 1. Diagnosis of the current IA

Measured from the shipped tree (routes, `sidebar.tsx`, `bottom-nav.tsx`),
not from the plan documents:

1. **The home is two products stacked.** `index.tsx` (1,149 lines) opens
   with the new verdict-first layer (regime hero, setups, trades/behavior
   strip, catalyst rail) — then the *entire legacy dashboard* continues
   below it: 5 hero metric tiles, tape strip, a second "Top Setups", market
   overview strip, top-assets table, news highlights, capital-flow heatmap,
   Fear & Greed, an AI overview block. The user gets the verdict and then
   scrolls into everything the verdict was built to replace. Cognitive
   load didn't drop; a summary was added on top of it.
2. **Three sibling pages answer "my trades" differently.** `/trades`
   (live positions + journal + execution), `/tracker` (engine forward-test
   record — *not* the user's trades), `/review` (synced-trade analytics).
   The nav labels them Tracker / Trade Review / Trades — indistinguishable
   to a new user, and Tracker isn't even about their trading. The
   improvement loop (Q3: "am I trading well?") is fragmented across three
   screens with three headers and three filter bars.
3. **The token page is an encyclopedia.** 4,250 lines, ~70 cards across
   five tabs (overview/why/plan/details/evidence). The verdict — the one
   thing the page exists to deliver — competes with every SMC read the
   engine can render. This is the "information vs. decision" failure at
   its largest.
4. **Nav carries decoration and fiction.** Sidebar has a "Market Pulse
   Pro / Upgrade Now" upsell card (there is no Pro plan — it's a dead
   button on a single-user product), a hardcoded "Pro Plan" user badge,
   and a market clock. News sits alone under an "Analysis" group.
   Grouping ("Overview / Analysis / Trading / Account") describes data
   types, not user tasks.
5. **The thesis action has no home.** Skip Check (R2) — the product's
   defining act — currently has nowhere to live: no nav slot, no global
   affordance. If it ships as another card on a crowded page, it dies.

## 2. Design rule

Every screen answers exactly one of the three questions, above the fold,
in words:

- **Q1 — Should I trade right now?**
- **Q2 — Is *this* trade good?**
- **Q3 — Am I trading well over time?**

Everything else is evidence, and evidence is *reachable, never ambient*:
one level down, collapsed, or behind a tab — present when summoned,
invisible when not.

## 3. New navigation

Five destinations. Task-named, one per question plus context plus config:

| Slot | Route | Question | Contents |
|---|---|---|---|
| **Today** | `/` | Q1 | Regime verdict, open risk, behavior flag, catalysts, 2–3 live setups. Nothing else. |
| **Check** | `/check` (+ global action) | Q2 | Skip Check: pick symbol + objective + direction → deterministic answer → (if viable) ticket → permit → confirm. |
| **Journal** | `/journal` | Q3 | Merge of `/trades` + `/review`: open positions, history, forensics, habits. |
| **Markets** | `/markets` | evidence for Q1/Q2 | Existing tab host, pruned (below) + token pages + engine record. |
| **Settings** | `/settings` | config | Constitution, keys, prefs, alerts. |

**Mobile bottom nav (5):** Today · Markets · **Check** (center, visually
primary — the FAB of the product) · Journal · Settings.

**Desktop sidebar:** same five, flat — group labels deleted (five items
need no taxonomy). **Deleted from the shell:** Pro upsell card, "Pro
Plan" badge, market clock (top bar already has freshness; a clock is
decoration). **News leaves the nav** (roadmap R1): reachable as a
filtered archive from catalyst items only.

**Route dispositions:**
- `/tracker` → becomes the **Record** tab inside `/markets` (it is
  evidence about the engine, not a daily destination; auto-followed
  engine trades are the engine's record, not the user's journal).
- `/trades` + `/review` → `/journal` (old routes redirect).
- `/news` → out of nav; route kept as archive, linked from catalysts.
- `/rankings` `/regime` `/rotation` `/technical` → already redirects;
  unchanged.

## 4. Screen redesigns

### 4.1 Today (`/`) — cut it in half

Keep (the shipped verdict-first layer, in this order):
1. **Regime verdict hero** — the call in words + one-sentence why +
   freshness.
2. **Open risk & behavior strip** — open positions with distance-to-stop;
   active behavior flag if any ("3rd entry on BTC today").
3. **Live setups (max 3)** — verdict-live tokens only, each with
   objective + what-flips-it → token page. Empty state says "no valid
   setups — that's a verdict, not an error" and links Check.
4. **Catalyst rail** — impact×proximity ranked (R1 wiring), each item →
   its token verdict.
5. **One Check entry point** — "Check a trade" button closing the fold.

**Delete from the home** (each either duplicates the verdict layer or is
raw data): hero metric tiles, tape/edge strip, legacy "Top Setups" block
(LiveSetupsStrip supersedes it), market overview strip, top-assets table
(lives in Markets→Assets), news highlights (catalyst rail supersedes),
capital-flow heatmap (Markets→Overview), standalone Fear & Greed tile
(regime hero already encodes conditions; keep F&G inside Markets→Regime),
ambient AI overview block (AI is on-demand via the sidebar/desk review,
not ambient prose). Net effect: the home becomes one screen, no scroll on
desktop, one short scroll on mobile.

### 4.2 Check (`/check`) — the thesis gets a room

New screen, thin UI over R2's contract:
1. **Input row:** symbol (default: last viewed token), objective
   (scalp/intraday/swing), direction, optional planned stop.
2. **Answer card:** verdict-colored — *supportive read* / *cautions,
   stated* / *no opinion — insufficient evidence* — with the typed blocks
   (constitution headroom, regime/objective fit, catalyst window,
   behavior flags) each one line + expandable evidence.
3. **What-flips-it line** — always present, even on "no".
4. **Continuation:** viable → "Build ticket" → sizing (never a qty
   input) → permit card → confirm (M9 path). Not viable → up to 3
   verdict-gated alternatives (roadmap R5) or "sit out" as a first-class
   suggestion.

Entry points: nav slot, home button, token-page verdict card, command
palette. The same surface is the pre-trade gate when execution is on and
the skip check when it's off — one mental model, one screen.

### 4.3 Journal (`/journal`) — one loop, three lenses

Merge `/trades` + `/review` into one route with three tabs (state
preserved in search params, same pattern as `/markets`):

- **Open** — live positions, permit-linked where IQ-placed, trade-lock
  actions (reduce-only) when execution is on, distance-to-stop, active
  event windows on held symbols.
- **History** — closed trades; each row → trade detail: facts, context
  stamp (R4), forensics (MAE/MFE, exit efficiency, stop discipline),
  counterfactuals labeled, AI memo on demand.
- **Habits** — the R4 distributions + the shipped review analytics
  (RR, best/worst hours, style-fit) reframed from stats into 1–2 named
  habits with evidence counts ("5 of 7 losses were re-entries within
  30 min of a loss"). No edge claims (M3 rule).

One header, one filter system, PnL/R rules per EDR 0017 throughout.

### 4.4 Token page — verdict first, evidence summoned

Restructure the 5-tab, ~70-card page into three layers:

1. **Verdict header (always visible):** per-objective verdict chips
   (scalp/intraday/swing) with the active one expanded — not-yet /
   wrong-strategy / what-flips-it — plus the catalyst line (R1) and a
   "Check this trade" button. This is the page's answer; it never
   scrolls away.
2. **Chart** with the existing event overlay + plan levels (entry/stop
   /target zones when a POI plan exists).
3. **Evidence (collapsed accordion, one level down):** the current
   why/plan/details/evidence content consolidated into: *Why this
   verdict* (structure, S/R, liquidity, POI — the reads that produced
   it), *Track record* (forward-test stats for this verdict type),
   *Context* (events, funding caution, market phase). Cards that restate
   the same read at different zoom levels get merged; target ≤ 20 cards
   total. Each evidence block cites which verdict line it supports —
   evidence that supports no line is deleted.

The 4,250-line file splits into feature components as part of this work
(mechanical, no behavior change) — a prerequisite for any agent safely
editing it.

### 4.5 Markets (`/markets`) — prune the tabs

Current: Markets / Rankings / Regime / Rotation / Technical. Rankings and
Technical are two sorts of the same asset list; Rotation is a regime
lens. New: **Overview** (snapshot + heatmap + top assets — absorbing the
home's deleted blocks that earn a place), **Regime** (pillars + F&G +
rotation folded in as a section), **Assets** (rankings + technical
merged: one sortable table, columns for score/RS/technical read, honest
tooltips preserved), **Record** (the relocated forward-test tracker).
Four tabs, each with a stated purpose line under the title.

### 4.6 Settings — becomes the rulebook

Elevate from prefs-dump to "your constitution": Trading Constitution
card first (it's the product's contract with the user), then keys
(sync / review / execution classes, clearly separated), alerts
(impact-gated), display prefs. No IA change beyond ordering.

## 5. User journeys (the four that matter)

1. **Morning glance (10 s, phone):** open Today → regime verdict + open
   risk + catalyst rail → close app or tap a setup. Success = a
   defensible "not today" in one screen.
2. **Itch to trade (2 min):** Today/token → **Check** → answer with
   reasons → ticket+permit *or* alternatives *or* sit-out. Every exit is
   a decision, none is a dead end.
3. **Post-trade (1 min):** close → notification → Journal detail: facts,
   stamp, forensics, memo. The habit gets named while the trade is fresh.
4. **Weekly review (10 min):** Journal → Habits: what repeated, 1–2
   habits, each traceable to trades. Feeds the next week's Check
   behavior flags.

Journey 2 is the product; every IA decision above exists to shorten it.

## 6. What this deletes (explicit)

- Home: hero tiles, tape strip, legacy top-setups, overview strip,
  top-assets table, news highlights, heatmap, F&G tile, ambient AI
  overview (all either die or move into Markets tabs).
- Shell: Pro upsell card + fake plan badge, market clock, nav group
  labels, News nav item.
- Routes: `/trades`, `/review`, `/tracker` as destinations (merged/
  relocated, redirects kept).
- Token page: every evidence card that supports no verdict line;
  duplicate-zoom cards merged (~70 → ≤ 20).

## 7. Build order (amends `ROADMAP-2026-07-23.md`)

IA work rides the existing R-items rather than forming a new track:

- **R1 gains:** nav regroup (5 slots, shell cleanup, deletions), home
  slim-down (§4.1), Markets tab prune (§4.5). All presentation; ships
  with the catalyst wiring since both touch home + token verdict card.
- **R2 gains:** the `/check` screen (§4.2) as Skip Check's surface, and
  the token-page restructure (§4.4) — verdict header + Check entry are
  one design. Token-file split is its own mechanical PR first.
- **R4 gains:** the Journal merge (§4.3) — lands with forensics, since
  History/Habits tabs are their display surface.
- **R6 unchanged.** Settings reorder (§4.6) is a small task inside R3
  (constitution card already exists there).

Agent fit per the roadmap's matrix: all §4 screen work is
Sonnet-executable against this spec; the token-page evidence triage
(which cards support which verdict line — judgment about what dies) is
an Opus brief; the mechanical file split and copy sweeps are
Haiku / Gemini 3.1 Flash.

## 8. Measures of success

- Today renders one screen (no desktop scroll); time-to-"trade or not
  today" under 10 s.
- Token page answers "is this trade good?" without opening a tab;
  evidence card count ≤ 20.
- One journal destination; zero duplicate filter systems.
- Check reachable in ≤ 2 taps from anywhere; every Check exit is a
  decision (trade / alternative / sit-out), never a dead end.
- Nav has five items, every label a task the target user recognizes.
