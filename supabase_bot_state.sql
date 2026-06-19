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


create table if not exists public.bot_knowledge (
  id text primary key,
  title text not null default '',
  content text not null default '',
  tags text[] not null default '{}'::text[],
  aliases text[] not null default '{}'::text[],
  scope text not null default 'global',
  source text not null default 'manual',
  confidence numeric not null default 0.7,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.bot_knowledge enable row level security;
