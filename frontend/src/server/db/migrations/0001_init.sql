-- Market Pulse — forward-test system of record + auth (Phase B).
-- gen_random_uuid() is core in PostgreSQL 13+; no extension needed.

-- ── Auth ───────────────────────────────────────────────────────────────────
create table if not exists users (
  id           uuid primary key default gen_random_uuid(),
  email        text unique not null,
  display_name text not null,
  is_admin     boolean not null default false,
  invited_by   uuid references users(id),
  created_at   timestamptz not null default now()
);

-- Invite-only account creation. An admin mints a token per tester; redeeming
-- it creates the user + opens the first session.
create table if not exists invites (
  token         text primary key,
  email         text,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  redeemed_at   timestamptz,
  redeemed_user uuid references users(id)
);

-- Passwordless re-auth on new devices: a single-use login link token.
create table if not exists login_tokens (
  token      text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- Opaque session tokens (httpOnly cookie). Multi-device by construction;
-- per-device revoke via revoked_at.
create table if not exists sessions (
  token        text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  device_label text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

-- ── Forward-test record (engine-owned, global) ──────────────────────────────
-- One row per scheduled evaluation pass, for provenance + debugging.
create table if not exists engine_run (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  engine_version text not null,
  config_hash    text not null,
  git_sha        text not null,
  universe_json  jsonb,
  status         text not null default 'ok',
  note           text
);

create table if not exists shadow_signal (
  id                 uuid primary key default gen_random_uuid(),
  symbol             text not null,
  market             text not null,
  intent             text not null,
  direction          text not null,
  setup_type         text not null,
  regime             text not null,
  timeframe          text not null,
  entry              double precision not null,
  stop               double precision not null,
  target1            double precision not null,
  target2            double precision not null,
  confidence         double precision not null,
  objective_resolved boolean,
  opened_at          timestamptz not null,
  status             text not null default 'active',
  closed_at          timestamptz,
  close_price        double precision,
  result_r           double precision,
  engine_version     text not null,
  config_hash        text not null,
  git_sha            text not null,
  engine_run_id      uuid references engine_run(id)
);
create index if not exists shadow_open_idx on shadow_signal (status);
create index if not exists shadow_group_idx on shadow_signal (symbol, timeframe, market);
create index if not exists shadow_combo_idx on shadow_signal (engine_version, setup_type, regime);
-- The worker's dedup: at most one active shadow record per symbol/market/intent.
create unique index if not exists shadow_active_uniq
  on shadow_signal (symbol, market, intent) where status = 'active';

create table if not exists anticipatory_signal (
  id                 uuid primary key default gen_random_uuid(),
  symbol             text not null,
  market             text not null,
  intent             text not null,
  direction          text not null,
  setup_type         text not null,
  regime             text not null,
  timeframe          text not null,
  verdict            text not null,
  entry              double precision not null,
  stop               double precision not null,
  objective          double precision not null,
  objective_strength text not null,
  zone_freshness     text not null,
  reward_risk        double precision not null,
  opened_at          timestamptz not null,
  status             text not null default 'pending',
  filled_at          timestamptz,
  closed_at          timestamptz,
  close_price        double precision,
  result_r           double precision,
  engine_version     text not null,
  config_hash        text not null,
  git_sha            text not null,
  engine_run_id      uuid references engine_run(id)
);
create index if not exists anticipatory_open_idx on anticipatory_signal (status);
create index if not exists anticipatory_group_idx on anticipatory_signal (symbol, timeframe, market);
-- A resting limit stays where it was placed while pending or filled (EDR 0010).
create unique index if not exists anticipatory_active_uniq
  on anticipatory_signal (symbol, market, intent) where status in ('pending', 'filled');

-- User-owned: a tester explicitly followed a call.
create table if not exists tracked_signal (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references users(id) on delete cascade,
  session_id           text references sessions(token),
  symbol               text not null,
  intent               text not null,
  direction            text not null,
  setup_type           text not null,
  timeframe            text not null,
  market               text,
  entry_low            double precision not null,
  entry_high           double precision not null,
  entry_price          double precision not null,
  stop                 double precision not null,
  target1              double precision not null,
  target2              double precision not null,
  confidence_at_follow double precision not null,
  followed_at          timestamptz not null default now(),
  status               text not null default 'active',
  close_price          double precision,
  closed_at            timestamptz,
  result_r             double precision,
  engine_version       text not null,
  config_hash          text not null,
  git_sha              text not null
);
create index if not exists tracked_owner_idx on tracked_signal (owner_id, status);

-- Verdict hysteresis state, server-owned so the worker can hold verdicts across
-- passes. Keyed by the reconcileHolds hold-key; payload is the HeldVerdict.
create table if not exists verdict_hold (
  hold_key   text primary key,
  symbol     text not null,
  market     text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists verdict_hold_scope_idx on verdict_hold (symbol, market);

-- ── Backtest runs (Phase D) ─────────────────────────────────────────────────
create table if not exists backtest_run (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  kind              text not null,
  engine_version    text not null,
  config_hash       text not null,
  git_sha           text not null,
  params_json       jsonb,
  gate_results_json jsonb,
  raw_path          text,
  verdict           text,
  note              text
);
create index if not exists backtest_kind_idx on backtest_run (kind, engine_version);
