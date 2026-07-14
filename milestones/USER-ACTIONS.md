# User actions — things only the owner can do

The agent references these by ID when blocked ("blocked on U3" in
PROGRESS.md). Ordered by when they're first needed. ☐ = pending.

## Before / during M0 (setup week)

- ☐ **U1 — Coding-tool auth.** Ensure `claude`, `codex`, and Antigravity CLIs
  are logged in / have active subscriptions on this VPS. Interactive logins
  are user-run (`! claude login` etc.). Needed by D-T0, blocks everything.
- ☐ **U2 — Deploy-path decision + GitHub secrets.** M0-T6: if you want
  push-to-main auto-deploy, add the repo secrets (SSH host/key) in GitHub —
  the agent can't. Otherwise say "manual is official" and the agent documents
  that instead.
- ☐ **U3 — EDR 0017 sign-off.** The direction EDR encodes owner decisions
  (custody, R rule, TradFi stance). Agent drafts it; you approve before it
  merges — it's your decision record, not the agent's.
- ☐ **U4 — Service restarts, ongoing.** Agent never runs `systemctl`. Any day
  PROGRESS says "needs restart: yes", run:
  `sudo systemctl restart market-pulse.service market-pulse-worker.service`.
- ☐ **U5 — Backlog from earlier phases (worth clearing now):** fix the stale
  `gitSha` in `/etc/market-pulse-worker.env`; add the external-context API
  keys (CoinMarketCal + CoinGecko/CMC) you already planned — they widen M2's
  external-context coverage from the moment they start ingesting.

- ☐ **U18 — Close the TLS bypass (with M0-T7).** The app on :3002 currently
  listens on all interfaces and ufw is inactive: check your cloud provider's
  security group and block inbound 3002 (and any other non-80/443/SSH ports),
  then restart the service after the agent lands the 127.0.0.1 bind. Only
  you can see/edit the provider firewall.
- ☐ **U19 — Decide: app-wide login or public dashboard?** Today the market
  dashboard is public and only user features (watchlist, follows) require
  login. Once trades import, journal data is auth-gated regardless (M1), but
  say whether the whole app should sit behind login too. Goes into EDR 0017.

## Before / during M1 (trade ingestion)

- ☐ **U6 — `MARKET_PULSE_SECRET_KEY`.** Generate the encryption master key
  (`openssl rand -hex 32`) and place it in both service env files yourself —
  the agent must never see or log it. Blocks M1-T2.
- ☐ **U7 — Binance read-only API key.** Create it in Binance (enable reading
  only; no spot/margin/futures trading, no withdrawals; IP-restrict to the
  VPS ideally) and enter it in Settings when M1-T3 lands. Blocks M1-T4+.
- ☐ **U8 — Permission-gate live test.** M1-T3's rejection test needs a
  trade-enabled key to prove rejection. Use an existing one briefly or skip
  the live half (fixture test only) — your call, one line in PROGRESS.
- ☐ **U9 — Privacy rule for committed reports.** M1-T8 / M5-T8 commit
  reconciliation and behavior reports. Default: redact to percentages/ratios.
  Confirm or change.

## During M3–M5 (forensics & analytics)

- ☐ **U10 — Account size.** Enter your account size in Settings when M3-T5
  ships — sizing-consistency metrics are undefined without it.
- ☐ **U11 — Behavior-cohort protocol sign-off.** M5-T1 freezes the segment
  family, min-n, and wording rules. Like the 1.0.0 verdict protocol, the
  thresholds are the owner's call: approve before FROZEN is stamped.

## During M4/M6 (AI + alerts) — non-blocking choices

- ☐ **U12 — Server-side AI key opt-in.** Scheduled morning briefs need a
  provider key in server custody (M1's encrypted store). Without opting in,
  briefs generate on first visit instead (client-side BYOK). Your choice.
- ☐ **U13 — Behavioral alert opt-ins.** M6-T6 alerts are opt-in toggles in
  Settings; flip on the ones you want.

## During M7–M8 (TradFi + productization)

- ☐ **U14 — Economic-calendar source key.** If M7-T6's chosen macro-calendar
  source needs an API key (FOMC/CPI/NFP), you sign up and provide it. Agent
  proposes the source + cost first.
- ☐ **U15 — Second real user.** M8-T4 needs a human you trust to onboard
  while observed. Only you can recruit them; agent mints the invite.
- ☐ **U16 — Landing copy + legal sign-off.** M8-T8's positioning and
  not-financial-advice wording ship only with your explicit approval.
- ☐ **U17 — CI deploy secrets (if U2 chose manual earlier).** M8-T5 revisits
  automation; same GitHub-secrets need as U2.

## Standing

- **New packages:** the 24h supply-chain guard may block fresh releases; the
  agent asks before touching `minimumReleaseAgeExcludes` — answer in
  PROGRESS or chat.
- **@agent notes:** anything you write in PROGRESS.md prefixed `@agent`
  overrides task order next run.
