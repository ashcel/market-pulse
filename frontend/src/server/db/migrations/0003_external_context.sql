-- External market context (breadth) — worker-ingested provider snapshots.
--
-- market_context_snapshot: one row per CoinGecko /global poll (~15min). The
-- web process reads the latest row plus the closest row ~24h older to derive
-- dominance/mcap deltas — dominance *trend* is why this is persisted history
-- rather than an in-memory cache (worker and web are separate processes).
create table if not exists market_context_snapshot (
  id                   uuid primary key default gen_random_uuid(),
  total_mcap_usd       numeric not null,
  btc_dominance        numeric not null,  -- percent of total market cap
  eth_dominance        numeric,
  mcap_change_24h_pct  numeric,
  source               text not null default 'coingecko',
  fetched_at           timestamptz not null default now()
);
create index if not exists market_context_fetched_idx
  on market_context_snapshot (fetched_at desc);

-- ingest_state: per-source bookkeeping for every external-context ingester.
-- Drives staleness flags and /api/external-context?view=health. A source with
-- no API key configured records status 'unconfigured' — skipped is a recorded
-- state, never silence — but only 'error'/stale sources degrade health.
create table if not exists ingest_state (
  source        text primary key,  -- 'coingecko-global' | 'coinmarketcal' | 'rss:<feed>'
  status        text not null,     -- ok | error | unconfigured
  last_ok_at    timestamptz,
  last_error    text,
  last_error_at timestamptz,
  updated_at    timestamptz not null default now()
);
