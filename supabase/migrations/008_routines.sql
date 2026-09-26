-- 008_routines.sql — Routines detection set (hero spec §9.1, build-now).
--
-- Notify-tier-only money watchdogs. Nothing here moves money, contacts
-- merchants, or acts autonomously: routines observe the ledger, upsert
-- findings, and append run rows. All writes are user-scoped (RLS: own rows).
--
-- Tables:
--   routines          — per-user registry of routines with on/off toggles
--   routine_findings  — idempotent findings (unique on user+routine+dedupe_hash)
--   routine_runs      — append-only transparency log of every routine run
--   expected_refunds  — user-registered refund expectations for refund watch

create table public.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  key text not null, -- refund_watch | trial_watch | price_hike | duplicate_charge | fee_sweep | overlap
  name text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique(user_id, key)
);

create table public.routine_findings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  routine_key text not null,
  kind text not null, -- price_hike | duplicate_charge | fee_sweep | overlap | refund_shortfall | refund_received | trial_watch
  title text not null,
  detail text not null default '',
  impact_cents integer not null default 0, -- positive; money at stake, for ranking
  evidence jsonb not null default '{}',    -- { transactions: [{id, merchant, amount_cents, date}], ... }
  status text not null default 'open' check (status in ('open','resolved','dismissed','snoozed')),
  snoozed_until date,
  dedupe_hash text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(user_id, routine_key, dedupe_hash)
);
create index routine_findings_open_idx
  on public.routine_findings (user_id, status, impact_cents desc, created_at desc);

create table public.routine_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  routine_key text not null,
  ran_at timestamptz not null default now(),
  checked_count integer not null default 0,  -- ledger rows scanned
  findings_count integer not null default 0, -- new findings created this run
  note text not null default ''
);
create index routine_runs_user_idx
  on public.routine_runs (user_id, ran_at desc);

create table public.expected_refunds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant text not null,
  amount_cents integer not null check (amount_cents > 0),
  expected_date date not null,
  status text not null default 'pending' check (status in ('pending','matched','shortfall')),
  matched_txn_id uuid references public.transactions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index expected_refunds_user_idx
  on public.expected_refunds (user_id, status);

alter table public.routines enable row level security;
alter table public.routine_findings enable row level security;
alter table public.routine_runs enable row level security;
alter table public.expected_refunds enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'routines','routine_findings','routine_runs','expected_refunds'
  ] loop
    execute format('create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
