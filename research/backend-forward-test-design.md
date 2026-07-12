# Backend design — durable, provenanced forward test

Drafted 2026-07-10, revised 2026-07-10 (auth in scope from day one; Postgres).
Status: **proposal, not yet started.** This is the design for moving the
shadow / anticipatory / tracked record off the browser and onto the server so
a forward test means something. It also folds in backtest storage and
**authentication (single-user, multi-device + closed beta with invited
testers)**. It does **not** cover real-money execution.

---

## 0. Why now, and what the real problem is

The instinct ("get the backend done, then auth") is right, but the framing
"migration vs. more SMC" hides the actual dependency. The forward-test
machinery today is **entirely client-side**:

- `shadow-signals`, `anticipatory-signals`, `tracked-signals`, `verdict-holds`
  are all zustand `persist` → **localStorage**, capped at 300 entries.
- Records are **opened** inside `useReconciledAssessments` (a client hook) —
  only for a symbol someone is actively viewing.
- Records are **settled** by `useSignalSettlement` — a `setInterval` in a
  `useEffect` that only advances **while a browser tab is open**.

Four consequences, each fatal to a credible forward test:

1. **Lossy** — clear storage / new device / different browser → the record is
   gone. There is no system of record.
2. **Capped** — 300 entries per store. A multi-week test over 18 symbols ×
   several intents ages out its own denominator; the hit-rate is computed over
   a sliding, self-truncating window.
3. **Biased** — signals only open for symbols someone looked at, only while
   online. This is survivorship + selection bias baked into the sampling
   frame. A database alone does not fix this; the **evaluation** must run
   server-side on a schedule over the whole universe.
4. **Unversioned** — there is **no `engineVersion` / `configHash` on any
   record** (confirmed: grep finds none). Every engine change silently mixes
   incompatible engine behaviors into one pooled hit-rate. This is the
   cheapest thing to fix and the most painful to retrofit.

So the deliverable is not "a database, then later auth." It is, in dependency
order:

1. **Provenance stamping** (cheap, gating, no DB) — so nothing recorded from
   now on is wasted, and engine changes *segment* the record instead of
   poisoning it.
2. **Postgres + auth from day one** — the persistence layer ships with
   `users` / `sessions` / `invites` and ownership on user data. The target is
   single-user across multiple devices plus a closed beta of invited testers,
   so multi-device sessions and per-user ownership are load-bearing
   requirements, not a later feature. Read/write APIs are auth-gated from the
   first endpoint.
3. **A server-side scheduled evaluator + settler** — the real backend. This is
   what removes the sampling bias; the DB is just where it writes. The engine's
   auto records are **engine-owned** (not per-user); only user actions (tracked
   follows) carry ownership.
4. **Backtest run storage** — fold the `research/scripts/*` JSON dumps into a
   queryable table keyed by engine version.

The zustand stores are demoted throughout to a read-through cache / offline
projection over the auth-gated, server-owned record.

### The one non-backend gate: engine stability

Do **not** start the *official* forward-test clock (call it engine version
`1.0.0`) until the **i.mss trigger** question from `phase2-spike.md` is
decided. The G1 expansion question is resolved (cross-TF retained, no new
structure state) — good, that was the churn most likely to invalidate a
running test. But the spike's deeper finding is that the internal-shift
*trigger* is mis-formalized (closed-bar-close-through-level vs. pivot-confirmed
CHoCH), and changing the trigger changes *what gets recorded*. Until that's
decided, records are stamped with a `0.x` dev version and treated as a
shakeout of the pipeline, not as evidence. Provenance stamping (step 1) is
exactly what lets us run the pipeline live *before* the engine is frozen
without contaminating the eventual `1.0.0` record.

---

## 1. Runtime reality (what we're building on)

- **Persistent process, not serverless.** Deploy is `bun run build` +
  `systemctl restart market-pulse` on a VPS (`.github/workflows/deploy.yml`).
  A long-lived process can host a scheduled loop directly — no external cron
  service required.
- **Settlement is already pure.** `settleShadowSignal`,
  `settleAnticipatorySignal`, `settleTrackedSignalWithCandles` are all
  `(signal, candles) → patch | null`. They move server-side **unchanged**.
- **Server compute pattern exists.** `fetchMarketSnapshotServer` is a
  `createServerFn` with a server-side TTL cache (`market.ts`). Kline fetching
  already has a server tier (`fetchBinanceKlinesServer`). The worker reuses
  these.
- **The evaluation pipeline is client-coupled.** The open decision lives in
  `useReconciledAssessments`: `assessIntents → applyRecordAdjustment →
  reconcileHolds → buildShadowSignal / buildAnticipatorySignal`, plus the
  `open()` writes and the hysteresis `holds` state. To run server-side this
  must be extracted into a **pure, framework-free** `evaluateSymbol()` that
  takes candles + prior hold-state and returns `{ displayAssessments,
  recordsToOpen, nextHolds }`. This extraction is the main engine-side refactor
  and is independently valuable (it makes the pipeline unit-testable without
  React).

---

## 2. Provenance model (step 1 — build this first, ~half a day, no DB)

A single source of truth for "which engine produced this record."

```ts
// src/lib/engine/version.ts
export const ENGINE_VERSION = "0.9.0-dev"; // bump on any decision/trigger change; → 1.0.0 when frozen
export const GIT_SHA = import.meta.env.VITE_GIT_SHA ?? "unknown"; // injected at build
export function configHash(settings: RiskSettings, thresholds: EngineThresholds): string
```

- **`ENGINE_VERSION`** — manually bumped when decision or trigger logic
  changes. Semver: major = trigger/decision semantics, minor = additive
  signal, patch = fix. This is the primary GROUP BY for all stats.
- **`configHash`** — a stable hash over `CRYPTO_RISK_SETTINGS` + the resolved
  engine thresholds (the scattered constants in `quant.ts` / `intent.ts` /
  `hysteresis.ts` that actually move outcomes). Captures **config-only** drift
  the version string would miss. Gather these into one `EngineThresholds`
  object so the hash has a defined surface.
- **`GIT_SHA`** — injected at build (`VITE_GIT_SHA` from the deploy step) for
  exact traceability.

**Every opened record gains three fields:** `engineVersion`, `configHash`,
`gitSha`. Add them to `ShadowSignal`, `AnticipatorySignal`, `TrackedSignal`
now as optional (records predating the field are pre-`1.0` shakeout anyway),
and stamp them at `open()`. **All stats functions (`shadowComboStats` and
friends) filter to the current `engineVersion` by default.** Ship this against
the *existing localStorage stores* — it is decoupled from the migration, so
the record starts accumulating provenance immediately and the migration
inherits it.

---

## 3. Persistence layer + auth (steps 2–3)

**Database: PostgreSQL.** Rationale (replaces the earlier SQLite-first call):

- The target is **one user across multiple devices + a closed beta of invited
  testers** — genuinely multi-user, multi-session, concurrent writers (each
  tester's browser plus the worker). Row-level ownership and real session
  management are day-one requirements, which is where Postgres pays off and
  single-file SQLite starts fighting you.
- Auth-ready schema (`users`, `sessions`, `invites`) is native and
  conventional in Postgres; concurrent session writes and `owner_id` foreign
  keys are exactly its job.
- Runs as its own service on the VPS (or a managed instance) next to the
  systemd units; standard `pg_dump` / PITR backups.

**Driver:** a Postgres client (e.g. `postgres` / `pg`) is a **new dependency**
— it trips the 24h supply-chain guard in `bunfig.toml`, so confirm with the
user before adding it to `minimumReleaseAgeExcludes`. Contain all SQL behind a
thin **repository layer** (`server/db/repo.ts`) so the engine never imports the
driver directly.

### Auth model (single-user + closed beta)

- **Invite-only.** No open sign-up. An `invites` row (token, email, created_by,
  expires_at, redeemed_at) is minted for each tester; redeeming it creates the
  `users` row. This is the whole beta gate — cheap and sufficient.
- **Sessions**, not stateless JWTs: a `sessions` table (opaque token → user,
  expiry, device label) gives multi-device login, per-device revocation, and a
  simple "log out everywhere." Cookie is httpOnly + secure; validated in a
  Nitro middleware that populates request context.
- **Ownership boundary:** engine auto records (shadow/anticipatory) are
  **engine-owned, global** — the engine's public track record, no `owner_id`.
  Only `tracked_signal` (a user chose to follow a call) carries
  `owner_id → users`. So the forward-test stats are shared across all testers;
  "my follows" are per-user.

### Schema (PostgreSQL)

```
users
  id            UUID PK
  email         TEXT UNIQUE
  display_name  TEXT
  created_at    TIMESTAMPTZ
  invited_by    UUID NULL REFERENCES users(id)

invites
  token         TEXT PK
  email         TEXT
  created_by    UUID REFERENCES users(id)
  created_at    TIMESTAMPTZ
  expires_at    TIMESTAMPTZ
  redeemed_at   TIMESTAMPTZ NULL
  redeemed_user UUID NULL REFERENCES users(id)

sessions
  token         TEXT PK          -- opaque, httpOnly cookie
  user_id       UUID REFERENCES users(id)
  device_label  TEXT
  created_at    TIMESTAMPTZ
  last_seen_at  TIMESTAMPTZ
  expires_at    TIMESTAMPTZ
  revoked_at    TIMESTAMPTZ NULL

engine_run
  id            TEXT PK              -- one row per loop pass
  started_at    TEXT
  finished_at   TEXT
  engine_version TEXT
  config_hash   TEXT
  git_sha       TEXT
  universe_json TEXT                 -- symbols × timeframes evaluated this pass
  status        TEXT                 -- ok | partial | error
  note          TEXT

shadow_signal
  id, symbol, market, intent, direction, setup_type, regime, timeframe,
  entry, stop, target1, target2, confidence, objective_resolved,
  opened_at, status, closed_at, close_price, result_r,
  engine_version, config_hash, git_sha,       -- provenance
  engine_run_id  REFERENCES engine_run(id)     -- which pass opened it

anticipatory_signal
  ... AnticipatorySignal fields ...,
  entry, stop, objective, reward_risk, opened_at, status, ...,
  engine_version, config_hash, git_sha, engine_run_id

tracked_signal                                  -- user explicitly followed a call
  ... TrackedSignal fields ...,
  owner_id      UUID NOT NULL REFERENCES users(id),   -- per-user from day one
  session_id    TEXT NULL REFERENCES sessions(token), -- which device followed
  engine_version, config_hash, git_sha

backtest_run                                     -- step 4
  id, created_at, kind, engine_version, config_hash,
  params_json, gate_results_json, raw_path, verdict
```

Indexes: `(status)` for the settler's open-set scan; `(symbol, timeframe,
market)` for the settlement grouping; `(engine_version, setup_type, regime)`
for combo stats. Settlement **updates rows in place** (status, closed_at,
close_price, result_r) exactly as the pure functions already return.

---

## 4. The server-side evaluator + settler (step 2 — the real backend)

A dedicated worker entrypoint, run as a **second systemd unit**
(`market-pulse-worker`) alongside the web service so evaluation stays off the
request path and survives web restarts independently.

```
server/worker.ts
  loop every EVAL_INTERVAL (e.g. 5m, aligned to the shortest exec TF):
    1. run = repo.startEngineRun({ engineVersion, configHash, gitSha, universe })
    2. for each (symbol, execTF, market) in UNIVERSE:
         candles = fetchBinanceKlinesServer(...)           // staggered, see rate-limit note
         { recordsToOpen, nextHolds } = evaluateSymbol(candles, repo.holdsFor(symbol), ...)
         repo.upsertHolds(symbol, nextHolds)               // hysteresis state now server-owned
         repo.openShadow / openAnticipatory(recordsToOpen, run.id)   // dedup on (symbol,market,intent,open)
    3. settle pass (independent cadence, e.g. every 5m):
         for each group in repo.openSignalsGroupedBy(symbol, tf, market):
             candles = fetchBinanceKlinesServer(symbol, tf, elapsedBars, market)
             apply settleShadowSignal / settleAnticipatorySignal / settleTracked* → repo.applyPatch
    4. repo.finishEngineRun(run.id, status)
```

Key points:

- **The worker is the sole writer of the auto records** (shadow +
  anticipatory). The client stops opening them. This is what removes the
  selection bias — the whole universe is evaluated every pass whether or not
  anyone is looking.
- **Hysteresis state (`holds`) moves server-side** — it's an input to the
  "favored" gate that opens shadow records, so the worker must own it (a
  `verdict_hold` table or in-worker memory rebuilt from open records on boot).
- **Settlement is unchanged logic** — same pure functions, same kline-walk
  catch-up (which also makes worker restarts self-healing: it walks klines
  since `opened_at`).
- **Rate limits** — the current client settler fetches per open group;
  server-side over the full universe × TFs needs staggering/batching against
  Binance weight limits. Reuse one kline fetch per (symbol, TF) pass for both
  eval and settle where the window overlaps.
- **Tracked signals stay user-initiated** (a "follow this call" action) but
  `POST` to the server on an **authenticated session**; `owner_id` and
  `session_id` come from the session context, so follows are per-user and
  per-device from the first write.

---

## 5. Client: stores become projections (step 3, cont.)

- New API: `src/routes/api/forward-test.ts` (`createFileRoute` +
  `server.handlers`, per the `api/klines.ts` convention) exposing
  `GET /api/forward-test/records`, `/stats`, `/runs`, and `POST /follow`. All
  handlers run behind the session middleware — global stats are readable by any
  authenticated tester; `/follow` and "my follows" are scoped to
  `session.user_id`.
- The zustand stores stop being the system of record. Two viable shapes:
  - **Read-through cache** — a `useForwardTestRecord` query (TanStack Query,
    like `useMarketSnapshot`) is the source; the store caches the last payload
    for offline/instant paint. Preferred — consistent with the existing
    snapshot architecture.
  - Keep the stores only for genuinely client-local state (UI prefs,
    watchlist).
- `useReconciledAssessments` keeps doing **live UI display** for the
  currently-viewed token (verdict shown to the user in real time) but **no
  longer writes** shadow/anticipatory records — the server owns that. It reads
  combo-stat adjustments from the server stats endpoint.
- `useSignalSettlement` is **deleted client-side** (the worker settles).

Net effect: the browser becomes a *view* over a server-owned record. Same UI,
honest data.

---

## 6. Backtest storage (step 4)

Today's gated comparisons (e.g. `phase2-spike/results-2026-07-10.json`) are
loose JSON under `research/scripts/`. Give them a home:

- `backtest_run` table (schema above). Each spike/gated run inserts a row:
  `params_json` (universe, window, gates), `gate_results_json` (the A–D table),
  `verdict`, `raw_path` (keep the raw file too).
- Keyed by `engine_version` + `config_hash` → you can **diff a backtest across
  engine versions** and see whether a change actually moved the gates, which is
  exactly the evidence discipline the EDR/spike process already wants.
- Thin CLI wrapper so `research/scripts/*` writes both the JSON and the row.

---

## 7. Auth (in scope from day one)

Ships with the persistence layer, not after it — the closed beta cannot exist
without it. Scope is deliberately minimal for an invite-only tool:

- **Invite flow:** an admin (the first user, seeded manually) mints an
  `invites` token per tester; redeeming it (via emailed link) creates the
  `users` row and opens a session. No open registration, no password-reset
  flows to build for a handful of testers — magic-link / invite-token redeem is
  enough. (A password or passkey can be added per-user later without schema
  change.)
- **Sessions:** opaque token in an httpOnly+secure cookie, validated in a Nitro
  middleware that populates request context with `user_id`. Multi-device by
  construction; `sessions` rows give per-device revoke and "log out
  everywhere."
- **Ownership:** engine auto records stay global/engine-owned; `tracked_signal`
  is scoped to `owner_id`. The forward-test track record is shared across
  testers (that's the point of a beta); personal follows are private.
- **Not in scope:** roles/permissions beyond admin-mints-invites, OAuth
  providers, org/team structures. Add if the beta outgrows one inviter.

---

## 8. Phasing & sequencing

| Phase | Deliverable | DB? | Blocks on |
|---|---|---|---|
| **A** | Provenance: `version.ts`, `configHash`, stamp records at `open()`, stats filter by `engineVersion`. Ship against current localStorage stores. | no | nothing — **do this week** |
| **A′** | Extract pure `evaluateSymbol()` out of `useReconciledAssessments`. | no | A (shares the record shape) |
| **B** | Postgres + repo layer + full schema (**incl. `users`/`sessions`/`invites`**) + session middleware + invite/redeem/login flow. Confirm driver against the supply-chain guard. | yes | A |
| **B′** | Auth-gated `/api/forward-test` read + `/follow` endpoints. | yes | B |
| **C** | Worker: server-side eval + settle over UNIVERSE; move `holds` server-side; client stores → read-through cache; delete `useSignalSettlement`. | yes | A′, B |
| **D** | `backtest_run` storage; CLI wrapper for the research scripts. | yes | B |
| **E** | Freeze engine → bump `ENGINE_VERSION` to `1.0.0`; **start the official forward-test clock**. | — | **i.mss trigger decision** (phase2-spike) |

The critical-path insight is unchanged by pulling auth forward: **A is cheap
and unblocks everything, and E (the clock that actually matters) is gated on an
SMC decision, not on the backend.** Auth now lands *with* the database (B) so
the closed beta can start using a real login the moment persistence exists,
rather than migrating anonymous records later. So build A → A′ → B → B′ → C in
parallel with deciding the i.mss trigger; the backend + auth can be fully ready
and quietly accumulating a `0.9-dev` record while the engine is finalized, then
a one-line version bump starts the real test.

---

## 9. Open decisions (need your call)

1. **i.mss trigger** — in-scope before `1.0.0`, or explicitly deferred and the
   clock starts on the current (pivot-confirmed CHoCH) trigger? This is the
   only thing gating a *meaningful* forward test. (SMC decision.)
2. **Postgres host** — self-hosted on the VPS (one more systemd/container unit)
   vs. a managed instance. Also confirm adding the driver to the
   supply-chain-guard `minimumReleaseAgeExcludes`.
3. **Auth mechanism** — recommend invite-token magic-link redeem + opaque
   session cookies (no passwords) for the beta. Confirm, or add passwords/
   passkeys now.
4. **Worker locality** — second systemd unit (recommended, isolated) vs.
   in-process Nitro startup hook (simpler, coupled to web restarts).
5. **Eval cadence** — 5m fixed, or per-exec-TF (15m/1h/4h evaluated on their
   own close)? Per-TF is more faithful but more scheduling.
6. **Pre-migration record** — discard the existing localStorage record at
   cutover (cleanest; it's unversioned and biased), or import it stamped as
   `0.0-legacy`? Recommend discard.

---

## 10. As-built status (2026-07-10)

Phases A–D shipped and verified end-to-end against a live Postgres (docker,
`docker-compose.yml`, `:5435`). One `runOnce` worker pass evaluated all 18
universe assets, opened shadow + anticipatory records, and persisted 72
server-side verdict holds; auth (login-token + invite/redeem, re-redeem
blocked), stats, follow, and `backtest_run` insert all exercised. `bun run
lint` (0 errors), `bun test` (272 + new provenance/evaluate tests), and `bun
run build` all pass; the client bundle was grepped clean of `postgres` /
`DATABASE_URL` (server-only isolation holds).

| Phase | Shipped | Notes |
|---|---|---|
| **A** | ✅ | `version.ts` (`ENGINE_VERSION` / `configHash` / `gitSha`); stamped on shadow, anticipatory, tracked; `shadowComboStats` segments by version. |
| **A′** | ✅ | `evaluate.ts::evaluateSymbol` — client hook + worker share one path. |
| **B** | ✅ | `postgres.js` client (server-only), `0001_init.sql` + runner, `repo.ts`, auth store + session cookies, `/api/auth`, `/login`, `docker-compose.yml`, seed-admin / mint-invite CLIs. |
| **B′** | ✅ | `/api/forward-test` (stats / runs / follows + `POST` follow), auth-gated. |
| **C** | ✅ eval+settle+holds server-side; ⏳ **client cutover deferred** | Worker (`src/server/worker`) is the system of record. The client stores + `useSignalSettlement` are **left intact** on purpose (Lovable working-state + app stays live). Final cutover — read-through `useForwardTestRecord` hook, stop client-side auto-open, delete `useSignalSettlement` — is the one remaining step, gated on the worker running in prod. |
| **D** | ✅ | `backtest_run` + `record-backtest.ts` CLI. |
| **E** | ⛔ **held** | See below. |

**Decisions resolved:** Postgres (self-hosted docker, dedicated container on
`:5435`); the driver is `postgres@3.4.9` — an established release, so it did
**not** trip the 24h supply-chain guard (no `minimumReleaseAgeExcludes` entry
needed). Auth = invite-token + opaque session cookies, no passwords. Worker =
separate process (`bun run src/server/worker`), intended as a second systemd
unit. Eval cadence = 5m fixed (`WORKER_INTERVAL_MS`). Legacy localStorage
record = discard at cutover.

## 11. Phase E decision — the clock stays at `0.9.0-dev`

**Do not bump to `1.0.0` yet.** The whole point of provenance is that the
*official* forward-test clock starts only on an engine we are not about to
rewrite — and `phase2-spike.md` leaves the **i.mss trigger** genuinely open
(closed-bar-close-through-level vs. pivot-confirmed CHoCH). Starting the clock
now would either freeze the engine mid-question or contaminate the `1.0.0`
record with a trigger change. So the backend runs live and accumulates a
`0.9.0-dev` record — real, queryable, provenance-stamped, but explicitly
*shakeout*, not evidence. The bump to `1.0.0` is a one-line change in
`version.ts` the moment the i.mss trigger is decided; nothing else blocks it.

## 12. Long-term architecture rationale

- **`postgres.js` + hand-written SQL migrations + a thin typed repo**, not an
  ORM. The record is a system of record: transparent SQL and a single,
  well-established driver beat an ORM's abstraction here, and it keeps the
  dependency surface (and supply-chain-guard exposure) minimal. Drizzle remains
  a clean future option behind the `repo.ts` seam if typed query ergonomics
  start to matter — the repo layer is the swap point.
- **Server-only isolation under `src/server/`** reached only through API route
  handlers, server functions, and the worker — never a client import. Verified
  by the build (postgres lands in `.output/server`, absent from the client
  bundle).
- **The worker is the system of record; the browser is a view.** The pure
  `evaluateSymbol` + pure settlement functions run identically client- and
  server-side, so the server can be authoritative without a second engine.
