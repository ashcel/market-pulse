-- Auto-track + unlock-slug resolution, backing the DeFiLlama unlock calendar
-- (CoinMarketCal was retired 2026-07-18). Both tables are worker-owned reads;
-- the web tier only writes tracked_token (on token open) via /api/track-token.

-- Tokens the user has opened. Together with the starred watchlist and the
-- fixed WORKER_UNIVERSE, this is the set the unlock pass fetches calendars for.
-- Global (not per-user): the worker's fetch scope is a property of the box,
-- and last_opened_at lets a future prune drop tokens nobody has viewed lately.
create table if not exists tracked_token (
  ticker         text primary key,        -- canonical bare ticker (uppercase)
  first_seen_at  timestamptz not null default now(),
  last_opened_at timestamptz not null default now()
);
create index if not exists tracked_token_last_opened_idx on tracked_token (last_opened_at);

-- Resolver cache: ticker → DeFiLlama emissions slug, by exact gecko_id join.
-- slug NULL means "resolved, but this token has no unlock schedule" — a cached
-- negative so we don't re-attempt every pass. checked_at drives re-resolution
-- TTL (a token can gain a schedule later).
create table if not exists unlock_slug_cache (
  ticker      text primary key,
  gecko_id    text,
  slug        text,                        -- NULL = no emissions/unlock data
  checked_at  timestamptz not null default now()
);
