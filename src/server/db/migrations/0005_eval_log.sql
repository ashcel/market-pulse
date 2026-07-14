-- Migration: 0005_eval_log.sql
-- Create table for forward test evaluation logs

create table if not exists eval_log (
  id              uuid primary key default gen_random_uuid(),
  engine_run_id   uuid references engine_run(id),
  evaluated_at    timestamptz not null default now(),
  symbol          text not null,
  market          text not null,
  intent          text not null,
  verdict         text not null,
  direction       text,
  setup_type      text not null,
  regime          text not null,
  timeframe       text not null,
  confidence      double precision,
  -- Backtest snapshot at eval time
  bt_win_rate     double precision,
  bt_expectancy   double precision,
  bt_avg_r        double precision,
  bt_total_trades integer,
  bt_low_sample   boolean,
  -- Gate state
  no_trade_reasons jsonb,
  component_scores jsonb,
  -- Engine provenance
  engine_version  text not null,
  config_hash     text not null,
  git_sha         text not null
);

create index if not exists eval_log_lookup_idx on eval_log (symbol, market, intent, evaluated_at);
create index if not exists eval_log_verdict_idx on eval_log (verdict);
create index if not exists eval_log_bt_idx on eval_log (bt_win_rate, bt_total_trades);
