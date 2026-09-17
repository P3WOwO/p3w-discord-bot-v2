-- Таблица RPG-профилей. Запусти один раз в Supabase -> SQL Editor.
create table if not exists public.rpg_state (
  user_id text primary key,
  guild_id text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.rpg_state enable row level security;
