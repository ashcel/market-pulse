-- Server-side mirror of the cap-segment trading preference (big-cap vs
-- small-cap), so it follows the user across devices. The zustand
-- "iq-preferences" store remains the offline source of truth per CLAUDE.md —
-- this table is a sync target, not a system the app reads hot-path from.
create table if not exists user_preference (
  user_id      uuid primary key references users(id) on delete cascade,
  cap_segment  text check (cap_segment in ('bigcap', 'smallcap')),
  updated_at   timestamptz not null default now()
);
