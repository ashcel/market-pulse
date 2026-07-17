-- Phase 2.5 — token event intelligence.
--
-- token_event: typed per-token events (unlocks, security incidents, listings,
-- regulatory actions...) extracted from news sources by the worker. Stored for
-- the WHOLE worker universe — relevance (watchlist / followed signals) is
-- applied at notification time, never at ingestion, so the history is complete
-- when a token later becomes relevant.
create table if not exists token_event (
  id           uuid primary key default gen_random_uuid(),
  symbol       text not null,
  kind         text not null,   -- unlock | security | regulatory | delisting | listing | upgrade
  severity     text not null,   -- info | warning | critical
  title        text not null,
  body         text,
  source       text not null,   -- cointelegraph | coindesk | ...
  url          text,
  published_at timestamptz not null,
  created_at   timestamptz not null default now(),
  -- One row per (article, symbol, kind); re-ingesting a feed is a no-op.
  dedup_key    text not null
);
create unique index if not exists token_event_dedup_uniq on token_event (dedup_key);
create index if not exists token_event_symbol_idx on token_event (symbol, published_at desc);
create index if not exists token_event_created_idx on token_event (created_at desc);

-- Server-side watchlist so the event watcher can target notifications at
-- signed-in users; doubles as multi-device watchlist sync. The zustand store
-- remains the offline cache for signed-out use.
create table if not exists user_watchlist (
  user_id  uuid not null references users(id) on delete cascade,
  symbol   text not null,
  added_at timestamptz not null default now(),
  primary key (user_id, symbol)
);
create index if not exists user_watchlist_symbol_idx on user_watchlist (symbol);
