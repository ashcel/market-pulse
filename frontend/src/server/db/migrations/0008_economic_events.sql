-- Economic calendar (ForexFactory weekly JSON). Unlike catalyst_event, these
-- are market-wide MACRO facts with no token symbol — a Fed decision, CPI print,
-- jobs report, ECB meeting — so they get their own table rather than being bent
-- into the token-shaped catalyst_event (symbol NOT NULL). The user trades both
-- crypto and Binance-listed tokenized TradFi, and macro is the shared backdrop.
--
-- Worker-owned writes (backend/app/worker/econ_pass.py via ingest_repo raw SQL);
-- the web tier only reads (/api/economic-events). Like catalyst_event the dedup
-- conflict is DO UPDATE: ForexFactory revises forecast/previous as a release
-- nears, and a genuine reschedule changes the feed date → a new dedup_key.
create table if not exists economic_event (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,          -- 'Core CPI m/m', 'FOMC Statement', ...
  country     text not null,          -- affected CURRENCY code: USD | EUR | GBP | JPY | ...
  impact      text not null,          -- high | medium | low | holiday
  forecast    text,                   -- consensus estimate, feed-formatted ('0.3%', '250K')
  previous    text,                   -- prior print, feed-formatted
  occurs_at   timestamptz not null,   -- scheduled release instant (UTC)
  source      text not null,          -- 'forexfactory' | 'forexfactory-next'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One row per (source, country, title, feed-date); re-ingesting is a no-op.
  dedup_key   text not null           -- 'forexfactory:{country}:{title}:{date}'
);
create unique index if not exists economic_event_dedup_uniq on economic_event (dedup_key);
create index if not exists economic_event_occurs_idx on economic_event (occurs_at);
create index if not exists economic_event_impact_occurs_idx on economic_event (impact, occurs_at);
