-- 006_pilot_analytics.sql — append-only analytics for the B2C pilot.
--
-- pilot_events stores one row per meaningful pilot interaction. The pilot
-- scorecard (activation, week-1 value, day-30 retention, payment proof) is
-- computed from this table — the view pilot_scorecard below is the single
-- definition of those metrics. Do not change the metric definitions mid-pilot;
-- add new events instead.
--
-- Privacy invariants (enforced in app code, documented here):
--   * properties carry buckets and labels only — never raw monetary values,
--     balances, account numbers, tokens, emails, or names.
--   * RLS is enabled with NO policies for anon/authenticated: only the
--     service role (server-side API route) can read or write. The founder
--     reads the scorecard view with the service key.

create table if not exists public.pilot_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_name text not null,
  properties jsonb not null default '{}'::jsonb,
  cohort text,
  acquisition_channel text,
  created_at timestamptz not null default now(),
  constraint pilot_events_name_check check (event_name in (
    'signup_completed',
    'account_link_started',
    'account_link_succeeded',
    'account_link_failed',
    'number_completed',
    'first_insight_viewed',
    'morning_brief_viewed',
    'what_if_saved',
    'recurring_item_reviewed',
    'equity_event_added',
    'next_action_recorded',
    'pricing_choice_shown',
    'pricing_plan_selected',
    'payment_completed',
    'data_export_requested',
    'account_deleted'
  ))
);

create index if not exists pilot_events_user_time_idx
  on public.pilot_events (user_id, created_at);
create index if not exists pilot_events_name_time_idx
  on public.pilot_events (event_name, created_at);

alter table public.pilot_events enable row level security;
-- Intentionally no policies: anon/authenticated get nothing; the service
-- role bypasses RLS. All writes go through POST /api/analytics (server).

-- ---------------------------------------------------------------------------
-- pilot_scorecard: THE single definition of pilot metrics. One row per user.
--   activated_at    — first number_completed ("Linked/entered data + Number")
--   first_value_at  — earliest of activation and first brief view
--   week1_value     — brief viewed AND an action/scenario within 7d of activation
--   day30_retained  — a meaningful event on days 22-30 after activation
-- Thresholds live in the pilot plan doc; this view supplies the raw flags.
-- ---------------------------------------------------------------------------
create or replace view public.pilot_scorecard as
with firsts as (
  select
    user_id,
    max(cohort) as cohort,
    min(created_at) filter (where event_name = 'signup_completed') as signed_up_at,
    min(created_at) filter (where event_name = 'number_completed') as activated_at,
    min(created_at) filter (where event_name = 'morning_brief_viewed') as first_brief_at,
    min(created_at) filter (where event_name in
      ('what_if_saved', 'recurring_item_reviewed', 'next_action_recorded')) as first_action_at,
    min(created_at) filter (where event_name = 'pricing_plan_selected') as plan_selected_at,
    min(created_at) filter (where event_name = 'payment_completed') as paid_at
  from public.pilot_events
  group by user_id
)
select
  user_id,
  cohort,
  signed_up_at,
  activated_at,
  case
    when activated_at is null then first_brief_at
    when first_brief_at is null then activated_at
    when first_brief_at < activated_at then first_brief_at
    else activated_at
  end as first_value_at,
  (
    activated_at is not null
    and first_brief_at is not null and first_brief_at <= activated_at + interval '7 days'
    and first_action_at is not null and first_action_at <= activated_at + interval '7 days'
  ) as week1_value,
  (
    activated_at is not null and exists (
      select 1 from public.pilot_events e
      where e.user_id = firsts.user_id
        and e.event_name in (
          'morning_brief_viewed', 'what_if_saved', 'recurring_item_reviewed',
          'next_action_recorded', 'number_completed', 'equity_event_added')
        and e.created_at >= firsts.activated_at + interval '22 days'
        and e.created_at <  firsts.activated_at + interval '31 days'
    )
  ) as day30_retained,
  plan_selected_at,
  paid_at
from firsts;
