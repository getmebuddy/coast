-- 009_tier1_retention.sql — Tier-1 retention set (Rocket Money teardown).
--
-- 1) watchlists table: user-configured notify-only spend watchers.
--    A watchlist names a merchant (substring match on the normalized
--    merchant) or a category, plus a monthly threshold in cents.
--    The watchlist routine (lib/routines.ts detectWatchlist) creates one
--    finding per watchlist per calendar month when month-to-date posted
--    spending crosses the threshold. Findings upsert by dedupe_hash
--    (watchlist:<id>:<YYYY-MM>); runs are logged in routine_runs like
--    every other routine. Nothing here moves money or contacts anyone.
-- 2) pilot_events allowlist: add 'spending_viewed' so the retention gate
--    can measure opens of the new /spending surface.

create table public.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null, -- display label, e.g. "Coffee shops"
  target_kind text not null check (target_kind in ('merchant', 'category')),
  target text not null, -- merchant substring (case-insensitive) or exact category
  threshold_cents integer not null check (threshold_cents > 0),
  created_at timestamptz not null default now()
);
create index watchlists_user_idx on public.watchlists (user_id, created_at desc);

alter table public.watchlists enable row level security;

create policy "own rows" on public.watchlists
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Extend the pilot_events allowlist with the new spending surface event.
alter table public.pilot_events
  drop constraint pilot_events_name_check;

alter table public.pilot_events
  add constraint pilot_events_name_check check (event_name in (
    'signup_completed',
    'account_link_started',
    'account_link_succeeded',
    'account_link_failed',
    'number_completed',
    'first_insight_viewed',
    'morning_brief_viewed',
    'spending_viewed',
    'what_if_saved',
    'recurring_item_reviewed',
    'equity_event_added',
    'next_action_recorded',
    'pricing_choice_shown',
    'pricing_plan_selected',
    'payment_completed',
    'data_export_requested',
    'account_deleted'
  ));
