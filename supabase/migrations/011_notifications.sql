-- 011_notifications.sql — notification system data model (spec v1 §6, §7, §12)
-- + trial_ends_on for the approved manual trial-end field (ruling 14.8).

-- Per-type notification preferences. prefs: { "<type>": false }; absent = default ON.
create table public.notification_prefs (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  prefs jsonb not null default '{}',
  unsubscribed_all boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
create policy "own rows" on public.notification_prefs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Send log. The unique(user_id, dedupe_key) constraint is the idempotency
-- guarantee: a sweep that runs twice cannot double-send.
-- Service-role only (the sweep writes it); no user policies by design.
create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  channel text not null default 'email',
  dedupe_key text not null,
  subject text not null,
  status text not null default 'sent', -- sent | skipped_no_provider | skipped_cap | skipped_prefs
  sent_at timestamptz not null default now(),
  clicked_at timestamptz,
  unique(user_id, dedupe_key)
);
create index notification_log_user_sent_idx on public.notification_log (user_id, sent_at desc);
alter table public.notification_log enable row level security;

-- Manual trial-end date on the curated recurring table. Nullable; when the
-- user sets it, trial_watch and the trial notification prefer it over the
-- ledger heuristic.
alter table public.recurring add column trial_ends_on date;

-- Extend the pilot_events allowlist with the notification events (spec §12).
alter table public.pilot_events drop constraint pilot_events_name_check;
alter table public.pilot_events add constraint pilot_events_name_check check (event_name in (
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
  'account_deleted',
  'notification_sent',
  'notification_clicked'
));
