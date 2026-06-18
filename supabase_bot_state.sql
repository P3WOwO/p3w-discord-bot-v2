-- Run this in Supabase -> SQL Editor
create table if not exists public.bot_state (
  row_id text primary key,
  voice_times jsonb not null default '{}'::jsonb,
  life_state jsonb not null default '{"startedAt": null, "phrase": null}'::jsonb,
  ai_memory jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.bot_state enable row level security;

insert into public.bot_state (row_id)
values ('main')
on conflict (row_id) do nothing;
