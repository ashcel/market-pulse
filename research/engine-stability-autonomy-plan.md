# Plan — engine stability/correctness + a self-running forward test

Drafted 2026-07-10. Status: **execution plan, not started.** Companion to
`backend-forward-test-design.md` (which is now built through Phase D). This
plan covers the two priorities agreed after that landed: **(1) engine
stability + correctness**, and **(2) making the forward test autonomous — a
self-contained unit that runs on its own**, no browser, no hand-holding.

Deliberately _not_ in scope: the Python ETL / feature plane (deferred — see the
project memory). This plan is about making what we have _trustworthy and
self-running_ before broadening the data.

---

## Guiding principles

1. **The record must be honest.** The autonomous worker is the authoritative
   writer, so what it records must equal what the engine would actually show a
   user for the same bar. Any divergence between the worker's evaluation inputs
   and the UI's is a correctness bug, not a detail.
2. **Correctness before the clock.** The `0.9.0-dev → 1.0.0` bump (the official
   forward-test clock) happens only on an engine we are not about to change.
3. **Engine changes are pre-registered spikes**, never casual edits — the same
   discipline used for G1 (`phase2-spike.md`) and required for G9.
4. **Autonomy = self-healing, not just running.** Crash → restart → catch up
   with no lost or double-counted records.

---

## Workstream 1 — Worker input parity (correctness) ⟵ start here

**Problem.** `src/server/worker/eval-pass.ts` evaluates with `perp: null` and
`sessionLevels: []` hardcoded. The token-page UI (`token.$symbol.tsx` →
`useReconciledAssessments`) evaluates with **real** session levels (and perp
context in perp mode). So the recorded decision can diverge from the engine's
true read — the record isn't honest.

**Tasks**

- [x] In the worker eval pass, compute session levels the same way the UI does:
      fetch ~168×1H klines via `fetchBinanceKlinesDirect` → `dropUnclosedCandle`
      → `computeSessionLevels` (`src/lib/engine/sessions.ts`). Pass them into
      `evaluateSymbol`. Landed as `fetchSessionLevels` in `sessions.ts`, wrapped
      by `fetchSessionLevelsServer` for the client hook — one function, two
      callers, no duplicated fetch/compute logic.
- [x] Scope the worker to **spot** for v1 (where `perp: null` is correct).
      Record the decision explicitly; perp evaluation is a later, separate pass
      with real `fetchPerpContext`. Documented inline on `runEvalPass` and
      `AssembledInputs.perp`.
- [x] Factor the "assemble evaluateSymbol inputs for a symbol" logic so the
      worker and the UI demonstrably build the same input object (a shared
      helper or a documented equivalence). Landed as
      `assembleEvaluateInputs` in `eval-pass.ts`.
- [x] Test: given identical candles, the worker's assembled inputs (evals,
      zones, sessionLevels) match the UI path for a fixture symbol. Landed as
      `src/server/worker/eval-pass.test.ts` (fake-Binance fixture + direct
      `fetchSessionLevels` comparison).

**Acceptance:** for a fixed candle set, worker-produced shadow/anticipatory
records are identical to what the token page would open. No hardcoded empty
inputs remain in the eval pass. **Done 2026-07-10.**

**Files:** `src/server/worker/eval-pass.ts`, `src/lib/engine/sessions.ts`,
possibly a new `src/lib/engine/assemble-inputs.ts` shared by hook + worker.

---

## Workstream 2 — Engine correctness hardening

Broader correctness net around the engine now that it runs unattended.

**Tasks**

- [x] **Worker/UI parity test** — one integration test that runs a symbol
      through both the worker path and the hook's `evaluateSymbol` call and
      asserts identical `display` + `shadowToOpen` + `anticipatoryToOpen`.
      Landed as `src/server/worker/parity.test.ts`. Found and deliberately
      excluded two non-decision divergence sources from the comparison:
      `evaluatedAt` (a hidden `Date.now()` stamp inside `evaluateSignal`,
      unused elsewhere) and the `accountSize`-derived dollar-sizing fields
      (worker evaluates at the `CRYPTO_RISK_SETTINGS` default of 100k, not any
      one tester's preference default of 10k) — neither is part of a
      persisted shadow/anticipatory record, and the test proves so explicitly
      rather than silently.
- [x] **Determinism/replay guard** — extend the existing
      `replay-safe-benchmark.test.ts` idea: same candles in ⇒ same records out,
      no wall-clock or ordering nondeterminism in the eval/settle path (audit
      `Date.now()` usage; the worker passes `nowMs` explicitly — keep it).
      Landed as `src/lib/engine/determinism.test.ts`: `evaluateSymbol` and all
      three settlement functions are pure under real-clock manipulation
      (`vi.setSystemTime`), and a multi-symbol pass is order-independent.
- [x] **Settlement invariants** — property tests: a settled record's `resultR`
      sign matches its terminal status; `expired` only at/after the intent's
      max-hold horizon; stop-before-target ordering within a bar holds
      (already covered by unit tests — consolidate into an invariant suite).
      Landed as `src/lib/engine/settlement-invariants.test.ts`: a seeded PRNG
      random-walk property suite (60 seeds × 2 directions) over shadow,
      anticipatory, and tracked settlement — the last of which (`tracker.ts`'s
      `walkExitLevels`/`settleTrackedSignalWithCandles`) had no test coverage
      at all before this.
- [x] **Provenance completeness** — assert every persisted record carries a
      non-empty `engineVersion`/`configHash`/`gitSha` (no `""` fallbacks in
      prod); fail the worker pass loudly if provenance is missing. Landed as
      `assertProvenance` in `src/lib/engine/version.ts`, called from
      `openShadow`/`openAnticipatory`/`followTracked` in `src/server/db/repo.ts`
      (replacing the old silent `?? ""` fallback); unit-tested in
      `version.test.ts` and DB-integration-tested in `repo-invariants.test.ts`
      (throws before any insert, writes nothing).
- [x] **Dedup correctness** — test the partial-unique indexes: a second open of
      the same still-open (symbol,market,intent) is a no-op, and a _new_ open is
      allowed only after the prior one settles. Landed as
      `src/server/db/repo-invariants.test.ts`, a real-Postgres integration
      suite (DATABASE_URL, dev docker-compose DB) exercising
      `shadow_active_uniq`/`anticipatory_active_uniq` directly; test rows are
      tagged with a symbol no real asset uses and cleaned up in
      `afterEach`/`afterAll`.

**Acceptance:** the parity + determinism + invariant suites are green in CI and
run on every push. **Done 2026-07-10** — 26 test files / 668 tests passing
(`bunx vitest run`), `bunx tsc --noEmit` clean (one pre-existing, unrelated
failure in `version.test.ts` left untouched), `bun run lint` clean.

---

## Workstream 3 — i.mss trigger spike (the correctness centerpiece, gates 1.0.0)

The open SMC question from `phase2-spike.md`: the internal shift is currently a
_pivot-confirmed CHoCH_ (knowable `k` bars late), but Dreimann's i.mss is a
_closed-bar close through a drawn internal level_ (knowable at that close). This
changes the **trigger** — i.e., what the record captures — so it must be settled
before the clock starts.

**Tasks**

- [ ] Write a **pre-registered spike protocol** (new `research/phase3-spike.md`),
      mirroring `analysis.md` §10: hypothesis (H-LB — level-break trigger),
      frozen shared components, gates A–D with thresholds and the
      "insufficient evidence loses" asymmetry, data window, paired unit.
- [ ] Implement the challenger trigger behind the frozen harness (no engine
      behaviour change to `main` until the gate passes).
- [x] Run the gated comparison; record raw results + verdict in the spike doc
      and persist via the `record-backtest` CLI (`kind=i-mss-spike`). Landed
      2026-07-10 — live 18-asset Binance capture (999 bars, 15m/1h/4h/1d, no
      rate-limiting hit), raw gates in
      `research/scripts/phase3-spike/results-2026-07-10.json` and
      `backtest_run 66e27582-f097-4c50-bbc2-be7e051b032c`.
- [x] Decide: adopt level-break trigger, or retain CHoCH. Either way the
      question is _closed_ and the engine is freezable. **Retain CHoCH** — Gate
      A passed (99.6% divergence) but Gate B failed (disagreement-set lift
      +0.005R, CI [-0.07, 0.08] straddles 0, threshold +0.15R) and Gate C
      failed (half-1 delta negative, only 8/18 assets H-LB-positive). See
      `research/phase3-spike.md` Results section for full gate table and the
      trx-tp3 fixture-sanity NO-MATCH finding.

**Acceptance:** a written verdict with gate evidence; the trigger question is no
longer open. **This is the only true blocker to `1.0.0`.** **Done 2026-07-10 —
CHoCH retained, WS6 unblocked.**

---

## Workstream 4 — Autonomy: the worker as a self-running unit ("its own singularity")

Make the worker run unattended on the VPS, self-healing across restarts.

**Tasks**

- [x] **systemd unit** `market-pulse-worker.service` — `ExecStart=bun run
    src/server/worker/index.ts`, `Restart=always`, `RestartSec`, `EnvironmentFile`
      for `DATABASE_URL`/`WORKER_INTERVAL_MS`/`GIT_SHA`. Add the unit file to the
      repo (e.g. `deploy/market-pulse-worker.service`). Landed as
      `deploy/market-pulse-worker.service` + `deploy/worker.env.example`
      (template for `/etc/market-pulse-worker.env`). **Not installed** —
      `sudo cp`/`daemon-reload`/`enable --now` left for manual deploy, per
      instruction not to touch live systemd/Caddy.
- [x] **Deploy wiring** — extend `.github/workflows/deploy.yml` to
      `systemctl restart market-pulse-worker` alongside the web service (and run
      `bun run db:migrate` before restart so schema is current). Landed —
      **the unit must be installed on the VPS before the next push to `main`**,
      or this step will fail the deploy job.
- [x] **DB in prod** — bring up Postgres via `docker-compose.yml` (or a managed
      instance) on the VPS; set `DATABASE_URL`. Confirm backups (`pg_dump`
      cron / PITR). Postgres (`market-pulse-db`, `docker-compose.yml`) was
      already running on this VPS before this session. Added
      `deploy/pg-backup.sh` (daily `pg_dump | gzip`, 14-day retention) — the
      cron line to install it is documented in the script, not installed here.
- [x] **Rate-limit safety** — over a long-running loop, stagger Binance fetches
      (the eval pass hits 22 symbols × 6 TFs + a settle pass); add spacing /
      shared-candle reuse and a weight budget so a pass can't get the IP banned.
      Landed as `src/lib/engine/rate-limit.ts` — a token-bucket weight budget
      (2000/min, a third of Binance's real 6000/min ceiling) shared by every
      `fetchBinanceKlinesDirect`/`fetchBinancePriceDirect` call (worker _and_
      web, since both import the same singleton), queued so concurrent
      acquires stagger instead of racing. Weight computed from Binance's real
      `/klines` schedule (1/2/5 by `limit`). No-ops under Vitest so the test
      suite's fake-Binance traffic never shares (and drains) the real budget.
      Unit-tested in `rate-limit.test.ts`.
- [x] **Observability** — the `engine_run` table already logs each pass + note;
      add a lightweight `/api/forward-test?view=health` (last run age, status,
      open-record count) and log a heartbeat line per pass. Optional: alert if
      no successful pass in N minutes. Landed: `countOpenRecords` (`repo.ts`),
      `healthSnapshot` (`forward-test/service.ts`, `status` = `ok`/`stale`
      after 3×`WORKER_INTERVAL_MS` silence/`error`/`never-run`), wired as the
      one unauthenticated view on `/api/forward-test` (the rest stay session-
      gated). The worker's existing per-pass `console.log` now also reports
      open-record counts. Alerting on staleness is left as a later addition
      (the `status` field is the hook for it).
- [x] **Idempotency proof** — kill the worker mid-pass, restart, confirm no
      double-count and full catch-up (the kline-walk already supports this —
      verify it). Landed as `src/server/worker/idempotency.test.ts` (real
      Postgres): a run that opens records then never calls `finishEngineRun`
      (simulated kill), followed by a full restart pass, proves (1) no
      double-open — the restart's attempt is a no-op tied to the _original_
      run's id, (2) full catch-up — a symbol run A never reached still opens
      cleanly on the restart, (3) the orphaned run stays orphaned
      (`finished_at` null) without blocking the next run, and (4) settled
      records are structurally invisible to a restarted settle pass (`status`
      filter, not a cursor) so they can't be re-settled.

**Acceptance:** the worker survives a reboot and a mid-pass kill, keeps the
record growing on its own, and its liveness is observable without SSH.
**Built 2026-07-10** — config/code done; **manual steps remain**: install the
systemd unit (`deploy/market-pulse-worker.service`), fill in
`/etc/market-pulse-worker.env` from the example, and install the
`pg-backup.sh` cron line — all deliberately left for manual deploy.

---

## Workstream 5 — Client cutover (retire the browser-gated path)

The remaining Phase C step from the backend design: make the browser a pure
_view_. Do this only **after** WS1 + WS4 (server must be trustworthy and
running before we lean on it).

**Tasks**

- [x] `useForwardTestRecord` read-through query (TanStack Query) over
      `/api/forward-test?view=stats` — the source of combo stats for
      `useReconciledAssessments`. Landed as `src/hooks/useForwardTestRecord.ts`
      (mirrors the server's `ForwardTestStats` shape locally rather than
      importing `@/server/*` into the client bundle; falls back to an empty
      record on a 401 so a signed-out visitor doesn't see a query error).
      `tracker.tsx`'s `EngineRecord` widget (same summary/combo shape) was also
      cut over to this hook so it doesn't go dark after the localStorage
      discard below.
- [x] Stop the client auto-opening shadow/anticipatory records; keep the stores
      as an offline/instant-paint cache only. Landed — `useReconciledAssessments`
      no longer calls `openShadow`/`openAnticipatory`; the effect only adopts
      held verdicts now. The stores/components that still _read_ them (e.g.
      `AnticipatoryRecordNote` on the token page) are untouched and just
      quietly stop gaining new entries.
- [x] Delete `useSignalSettlement` (the worker settles). Landed — file removed,
      unmounted from `__root.tsx`. **Caveat found during cutover:** the
      Signal Tracker's "Follow" action (`useTrackedSignalsStore.follow`) has
      never POSTed to the backend (`POST /api/forward-test` / `followTracked`
      exist server-side but no client call site ever hit them) — the tracked-
      signal table in Postgres is effectively always empty today. That means
      followed signals now have **no settlement path at all** client- or
      server-side, since `useSignalSettlement` was the only thing walking
      klines for them. This is a pre-existing gap the backend design doc's own
      Phase C status didn't flag, not something introduced by this cutover —
      but it now needs its own fix (wire `follow()` to `POST
    /api/forward-test`, read "my follows" from `?view=follows`) as a
      follow-up, tracked outside this plan.
- [x] Discard the legacy localStorage record at cutover (unversioned, biased).
      Landed as `version: 1` on both `iq-shadow-signals` and
      `iq-anticipatory-signals` persist configs (no `migrate` fn provided, so
      zustand discards the old persisted state on load rather than merging it
      back in as if still authoritative).

**Acceptance:** with the worker running, the UI's numbers come from the server;
disabling localStorage changes nothing but offline paint. **Done 2026-07-10** —
`bunx tsc --noEmit` clean (same one pre-existing `version.test.ts` failure as
before, untouched), `bun run lint` clean, `bunx vitest run` 676/676 passing
(28 files). The tracked-signal/follow settlement gap above is real and open —
flagged for a follow-up, not silently swallowed.

---

## Workstream 6 — Start the clock (1.0.0)

**Gated on WS3.** One-line change once the engine is frozen.

**Tasks**

- [x] Bump `ENGINE_VERSION` in `src/lib/engine/version.ts` to `1.0.0`.
- [x] Announce the cohort boundary; stats from here are _evidence_, prior are
      _shakeout_.

---

## Sequencing & dependencies

```
WS1 (input parity) ──┬─▶ WS2 (correctness net) ──┐
                     └─▶ WS5 (client cutover) ◀── WS4 (autonomy)
WS4 (autonomy) ── independent, can run in parallel with WS1/WS2
WS3 (i.mss spike) ── independent decision work ──▶ WS6 (bump to 1.0.0)
```

- **Now:** WS1 (safe, verifiable) + begin WS4 wiring.
- **Next:** WS2 net; WS3 spike design in parallel (decision work, not plumbing).
- **Then:** WS5 cutover (needs WS1+WS4 solid).
- **Finally:** WS3 verdict → WS6 bump.

## Definition of done — "forward tests on its own"

1. Worker records == engine's true read (WS1) and stays that way (WS2 parity).
2. Worker runs unattended on the VPS, self-heals across restart, liveness
   visible (WS4).
3. The UI reads the server record; no browser is required for the test to
   advance (WS5).
4. The engine is frozen and the `1.0.0` clock has started (WS3 → WS6).

## Open decisions

1. **i.mss trigger** — ~~adopt level-break or retain CHoCH~~ **resolved
   2026-07-10: CHoCH retained** (WS3 verdict, `research/phase3-spike.md`).
2. **Perp coverage** — spot-only forward test for v1, or add a perp pass?
3. **Prod DB** — self-hosted docker vs managed Postgres (WS4).
4. **Eval cadence** — keep 5m fixed, or per-exec-TF on bar close?
5. **Tracked-signal follow wiring** — `follow()` needs to `POST
/api/forward-test` and the Signal Tracker page needs to read `?view=follows`
   for followed signals to settle at all again post-WS5 (found during the WS5
   cutover; see WS5 notes).
