# M0 — Honesty pass & direction commit

**Goal:** the repo stops claiming what the evidence doesn't support, the new
direction is durably recorded, and the production tree is clean enough to
build on.

**Why first:** every later milestone cites the EDR this produces; and the
production working tree currently carries uncommitted work, which is an
operational hazard before an agent starts making daily commits.

## Success criteria (all measurable)

- [x] `git status` clean; all previously uncommitted work either landed (tests
      green) or explicitly reverted with a PROGRESS note saying why.
- [x] `docs/decisions/0017-*.md` (or next number) exists and records: product
      direction, engine-as-instrument stance, R-normalization rule, key
      custody choice, TradFi-via-Binance approach.
- [x] Homepage no longer presents engine calls as "Actionable Setups" /
      "Today's Edge"; framing is an intelligence brief.
- [ ] `docs/score-inventory.md` lists **every** user-facing number with its
      evidence basis and a keep/demote/remove decision; the "remove" rows are
      actually removed from the UI. *(inventory half done via M0-T4: the doc
      exists with decisions for every score; the "remove" rows are not yet
      removed from the UI — that's M0-T5.)*
- [ ] News sentiment either routed through BYOK classification or visibly
      labeled as a keyword heuristic (not presented as "sentiment").
- [ ] Deploy path resolved: either the GH workflow reaches the VPS (verified
      by a real push-triggered deploy) or `deploy/README.md` documents the
      manual path as the official one and the workflow is disabled.

## Tasks

- [x] **M0-T1 — Land the in-flight work.** Review the modified/untracked files
      (spike detector, eval_log, notification changes). Run the full suite;
      fix or split anything failing; commit in logical units.
      *DoD:* clean `git status`, `bunx vitest run` green, committed to main.
- [x] **M0-T2 — Write EDR 0017 (product direction).** Contents: (1) product =
      decision journal + intelligence brief + behavior review, AI as
      complement; (2) engine = context instrument pending its 1.0.0 verdict;
      (3) R only when a stop order is evidenced, else % + MAE/MFE; (4) API-key
      custody = server-side, AES-256-GCM encrypted at rest, key from env,
      read-only-permission enforced; (5) TradFi = via Binance TradFi tickers,
      gated on M7-T1's instrument-semantics survey. Reference the
      2026-07-14 audit.
      *DoD:* EDR committed; linked from CLAUDE.md architecture section.
- [x] **M0-T3 — Homepage reframe.** `routes/index.tsx`: "Today's Edge" →
      intelligence brief (what moved, structural changes, upcoming events,
      discovery/spikes). "Actionable Setups" → "Engine reads" with explicit
      forward-test-in-progress labeling. Copy only + component reshuffle; no
      data-layer changes.
      *DoD:* no UI string implies proven edge; screenshots in PROGRESS entry.
- [x] **M0-T4 — Score inventory.** `docs/score-inventory.md`: every numeric
      surface (confidence gauges, discovery 0–100, location grades, backtest
      win rates, RS scores…) with columns: where shown, definition, evidence
      basis, decision (keep / demote-to-rank / remove).
      *DoD:* doc committed; decisions justified in one line each.
- [ ] **M0-T5 — Apply the score decisions + sentiment demotion.** Execute
      M0-T4's remove/demote rows; relabel regex sentiment as "keyword scan"
      or gate a BYOK classification path behind the user's existing AI key.
      *DoD:* UI matches the inventory doc; tests updated.
- [ ] **M0-T6 — Deploy path.** Inspect `.github/workflows/deploy.yml` +
      secrets; either fix (needs user to supply secrets — flag and wait) or
      make manual deployment the documented official path and disable the
      dead workflow.
      *DoD:* one true documented deploy path; no workflow that silently
      pretends to deploy.
- [ ] **M0-T7 — Transport hardening.** Audited 2026-07-14: the app on :3002
      listens on all interfaces with ufw inactive, so plain-HTTP access via
      the raw IP bypasses Caddy TLS (session cookies in cleartext). Prepare
      the fix: bind the app to 127.0.0.1 (HOST env in the systemd unit /
      start config) so Caddy is the only path in; verify Postgres stays
      loopback-bound; document in `deploy/`. Restart + cloud-security-group
      check are user-run (USER-ACTIONS U18).
      *DoD:* config change committed + documented; after the user restarts,
      `curl http://43.134.108.71:3002` from outside fails while
      `https://iq.heydewi.com` works (verification recorded in PROGRESS).
