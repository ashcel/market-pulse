-- Forward-looking catalysts (calendar-sourced). Unlike token_event (immutable
-- news, insert-or-ignore), calendar entries get rescheduled and re-scored —
-- the dedup conflict is DO UPDATE so a moved unlock date propagates.
create table if not exists catalyst_event (
  id                uuid primary key default gen_random_uuid(),
  symbol            text not null,        -- canonical bare ticker, or 'MARKET'
  kind              text not null,        -- unlock | listing | upgrade | fork | burn | other
  title             text not null,
  description       text,
  occurs_at         timestamptz not null, -- when the event happens
  source            text not null,        -- 'coinmarketcal'
  source_id         text,
  url               text,                 -- proof link
  credibility       jsonb,                -- { votes, confidencePct, hotScore }
  -- Unlock supply impact; null on the free tier. A null here means "size
  -- unknown" and the prompt layer must present the unlock as a scheduling
  -- fact, never a supply-pressure signal.
  percent_of_supply numeric,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  dedup_key         text not null         -- 'coinmarketcal:{source_id}:{symbol}'
);
create unique index if not exists catalyst_event_dedup_uniq on catalyst_event (dedup_key);
create index if not exists catalyst_event_symbol_occurs_idx on catalyst_event (symbol, occurs_at);
create index if not exists catalyst_event_occurs_idx on catalyst_event (occurs_at);
