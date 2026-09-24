-- 005_subscription_action_center.sql — Subscription Action Center persistence
--
-- Wave 1, task B: database migration for the Subscription Action Center
-- (spec: files/coast-subscription-cancel-negotiate-spec, sections 4 and 8).
-- Another agent builds the pure domain library in parallel; table/column
-- names here follow spec §8 exactly so the two stay in sync.
--
-- Safe to run on top of 001..004: every statement is IF NOT EXISTS-guarded
-- (via `add column if not exists`, `create table if not exists`, and
-- DO-block pg_constraint/pg_policy checks), following 002/004 style.
-- Does NOT touch existing columns on public.recurring.

-- ============ 1. extend the recurring detector output ============
-- Real table name/columns verified from 001_schema.sql (public.recurring)
-- plus 002_account_enrichment.sql (prev_amount_cents). No existing column
-- is renamed or deleted.
alter table public.recurring
  add column if not exists merchant_key text,
  add column if not exists billing_channel text,
  add column if not exists lifecycle_state text not null default 'active',
  add column if not exists user_correction text,
  add column if not exists amount_model jsonb,
  add column if not exists next_expected_at date,
  add column if not exists confidence numeric;

-- CHECK constraints are not IF NOT EXISTS-able; guard via pg_constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'recurring_lifecycle_state_check'
  ) then
    alter table public.recurring
      add constraint recurring_lifecycle_state_check
      check (lifecycle_state in ('active', 'kept', 'ended', 'reopened'));
  end if;
end $$;

comment on column public.recurring.merchant_key is 'Stable join key into merchant_registry. NULL until matched by an alias or user confirmation.';
comment on column public.recurring.billing_channel is 'direct | apple | google | other. NULL = unknown; never infer an app-store subscription from the card descriptor alone.';
comment on column public.recurring.lifecycle_state is 'active | kept | ended | reopened. Detection lifecycle; a resumed subscription becomes active again via a new charge.';
comment on column public.recurring.user_correction is 'not_recurring | not_subscription | duplicate. User correction to the detector; always wins over rules. NULL = no correction.';
comment on column public.recurring.amount_model is 'Representative rule metadata for the series (e.g. fixed amount, range, or recent average).';
comment on column public.recurring.next_expected_at is 'Next expected charge date. Drives the follow-up / likely-complete verification window.';
comment on column public.recurring.confidence is 'Detection confidence score from the recurring detector.';

create index if not exists recurring_user_lifecycle_idx
  on public.recurring (user_id, lifecycle_state);

-- ============ 2. merchant_registry (versioned capability catalog) ============
-- Global, read-only catalog for authenticated users. Seeds come from
-- verified merchant sources only — never from community data, and never
-- fabricated URLs, phone numbers, or timelines (spec §4).
create table if not exists public.merchant_registry (
  merchant_key text primary key,
  display_name text not null,
  aliases text[] not null default '{}',
  billing_channels text[] not null default '{direct}',
  supported_actions text[] not null default '{cancel}',
  route_type text not null default 'guide'
    check (route_type in ('direct', 'guide', 'assisted')),
  destination_ref text, -- allowlisted URL only; NULL for pure guides
  guide_steps jsonb, -- ordered steps
  requirements jsonb, -- login, phone, account-owner requirements
  warnings jsonb, -- contract / equipment notes
  source_checked_at timestamptz, -- freshness of the verification
  confidence text not null default 'low'
    check (confidence in ('high', 'medium', 'low')),
  jurisdiction text[] not null default '{US}',
  version integer not null default 1,
  active boolean not null default true, -- kill switch (independent of deploy)
  failure_count_7d integer not null default 0,
  last_failure_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.merchant_registry enable row level security;

-- Read-only for authenticated users: SELECT only, no insert/update/delete.
drop policy if exists "catalog read" on public.merchant_registry;
create policy "catalog read" on public.merchant_registry
  for select to authenticated using (true);

create index if not exists merchant_registry_active_idx
  on public.merchant_registry (active) where active = true;

-- ============ 3. action_requests ============
-- One cancellation / pause / downgrade / negotiation request.
-- status is the 14-state canonical machine from spec §8.
create table if not exists public.action_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  series_id uuid references public.recurring(id) on delete set null,
  merchant_key text,
  action_type text not null
    check (action_type in ('cancel', 'pause', 'downgrade', 'negotiate')),
  route_type text not null
    check (route_type in ('direct', 'guide', 'assisted')),
  status text not null default 'identified'
    check (status in (
      'identified', 'draft', 'action_started', 'needs_you', 'authorized',
      'submitted', 'reported_complete', 'likely_complete', 'confirmed_complete',
      'failed', 'unsupported', 'withdrawn', 'reopened', 'kept'
    )),
  registry_version integer,
  consent_id uuid,
  idempotency_key text not null,
  pricing_version text,
  verification_level text
    check (verification_level in ('reported', 'likely', 'confirmed')),
  opened_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

alter table public.action_requests enable row level security;

drop policy if exists "owner read" on public.action_requests;
create policy "owner read" on public.action_requests
  for select using (user_id = auth.uid());
drop policy if exists "owner insert" on public.action_requests;
create policy "owner insert" on public.action_requests
  for insert with check (user_id = auth.uid());
drop policy if exists "owner update" on public.action_requests;
create policy "owner update" on public.action_requests
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists action_requests_user_status_idx
  on public.action_requests (user_id, status);
create index if not exists action_requests_user_series_idx
  on public.action_requests (user_id, series_id);

-- ============ 4. action_events (append-only) ============
-- Every canonical transition appends an event BEFORE the request row is
-- updated. No UPDATE/DELETE policies: history is immutable.
create table if not exists public.action_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.action_requests(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  actor_type text not null
    check (actor_type in ('user', 'system', 'operator', 'partner')),
  actor_ref text,
  payload jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

alter table public.action_events enable row level security;

drop policy if exists "owner read" on public.action_events;
create policy "owner read" on public.action_events
  for select using (user_id = auth.uid());
drop policy if exists "owner insert" on public.action_events;
create policy "owner insert" on public.action_events
  for insert with check (user_id = auth.uid());
-- intentionally NO update or delete policies: append-only enforced by RLS.

create index if not exists action_events_request_idx
  on public.action_events (request_id, occurred_at);
create index if not exists action_events_user_idx
  on public.action_events (user_id, occurred_at);

-- ============ 5. consents ============
-- Narrow consent: one merchant, one action, approved fields, versioned
-- terms, one expiration. proof is proof-of-user-action metadata only,
-- never secrets (no passwords are stored anywhere in Coast).
create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid references public.action_requests(id),
  merchant_key text not null,
  action_type text not null
    check (action_type in ('cancel', 'pause', 'downgrade', 'negotiate')),
  approved_fields jsonb not null default '[]',
  terms_version text not null,
  operator_or_partner text,
  fee_cents integer,
  expires_at timestamptz not null,
  withdrawn_at timestamptz,
  proof jsonb,
  created_at timestamptz not null default now()
);

alter table public.consents enable row level security;

drop policy if exists "owner read" on public.consents;
create policy "owner read" on public.consents
  for select using (user_id = auth.uid());
drop policy if exists "owner insert" on public.consents;
create policy "owner insert" on public.consents
  for insert with check (user_id = auth.uid());
drop policy if exists "owner update" on public.consents;
create policy "owner update" on public.consents
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists consents_request_idx
  on public.consents (request_id);

-- link requests to their consent (no FK: consents.request_id already points
-- the other way; a circular FK would block both inserts)
comment on column public.action_requests.consent_id is 'Authorization reference into public.consents. Intentionally not an FK: the consents.request_id reference already points back here, so both rows insert in one flow without a circular constraint.';

-- ============ 6. evidence_objects ============
-- Private evidence: bytes live in the action-evidence storage bucket, never
-- in analytics. Only metadata / structured values are rows here.
create table if not exists public.evidence_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null references public.action_requests(id) on delete cascade,
  kind text not null
    check (kind in ('screenshot', 'structured', 'email_ref')),
  description text,
  storage_path text, -- private bucket path (bucket/id path), bytes in storage
  structured_value text, -- e.g. 'merchant_showed_cancelled'
  created_at timestamptz not null default now()
);

alter table public.evidence_objects enable row level security;

drop policy if exists "owner read" on public.evidence_objects;
create policy "owner read" on public.evidence_objects
  for select using (user_id = auth.uid());
drop policy if exists "owner insert" on public.evidence_objects;
create policy "owner insert" on public.evidence_objects
  for insert with check (user_id = auth.uid());
drop policy if exists "owner update" on public.evidence_objects;
create policy "owner update" on public.evidence_objects
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists evidence_objects_request_idx
  on public.evidence_objects (request_id);

comment on column public.evidence_objects.storage_path is 'Private path in the action-evidence bucket (user_id/filename). Bytes live in storage, never in analytics.';
comment on column public.evidence_objects.structured_value is 'Structured evidence value, e.g. merchant_showed_cancelled or cancellation_email_received.';

-- private storage bucket for screenshots (no storage precedent in 001..004,
-- so this is guarded and idempotent-safe)
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('action-evidence', 'action-evidence', false)
  on conflict (id) do nothing;
end $$;

-- bucket objects are keyed user_id/filename; users can only touch their own prefix
drop policy if exists "owner read action evidence" on storage.objects;
create policy "owner read action evidence" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'action-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owner write action evidence" on storage.objects;
create policy "owner write action evidence" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'action-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owner delete action evidence" on storage.objects;
create policy "owner delete action evidence" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'action-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============ 7. savings_outcomes ============
-- Savings are derived from the verified outcome, never double-counted:
-- recurring savings annualize only the verified recurring delta (temporary
-- promotional discounts are modeled only for their known duration), and
-- refunds are one-time events, never annualized.
create table if not exists public.savings_outcomes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null references public.action_requests(id) on delete cascade,
  monthly_cents integer not null default 0,
  annual_cents integer not null default 0,
  one_time_cents integer not null default 0,
  modeled_months integer,
  verification text not null
    check (verification in ('reported', 'likely', 'confirmed')),
  basis jsonb,
  created_at timestamptz not null default now()
);

alter table public.savings_outcomes enable row level security;

drop policy if exists "owner read" on public.savings_outcomes;
create policy "owner read" on public.savings_outcomes
  for select using (user_id = auth.uid());
drop policy if exists "owner insert" on public.savings_outcomes;
create policy "owner insert" on public.savings_outcomes
  for insert with check (user_id = auth.uid());
drop policy if exists "owner update" on public.savings_outcomes;
create policy "owner update" on public.savings_outcomes
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists savings_outcomes_request_idx
  on public.savings_outcomes (request_id);

comment on column public.savings_outcomes.basis is 'Calculation basis: prior vs new recurring amount, duration the saving applies to, and any assumptions made.';

-- ============ 8. feature_flags ============
-- Global kill switches for launch-gated capabilities. Default OFF per the
-- locked decisions; per-merchant gating lives in merchant_registry.active.
create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text,
  created_at timestamptz not null default now()
);

alter table public.feature_flags enable row level security;

drop policy if exists "catalog read" on public.feature_flags;
create policy "catalog read" on public.feature_flags
  for select to authenticated using (true);

insert into public.feature_flags (key, enabled, description) values
  ('assisted_cancellation', false,
   'Assisted cancellation via operator/partner. Off until legal review approves the model; per-merchant gate is merchant_registry.active.'),
  ('bill_negotiation', false,
   'Negotiation pilot (residential internet + mobile only). Off until legal review and partner capability are in place.')
on conflict (key) do nothing;

-- ============ 9. create_action_request (idempotent request RPC) ============
-- Inserts a request; an idempotent retry with the same idempotency key
-- returns the original row instead of failing (FR-10). SECURITY INVOKER so
-- RLS still applies, and the passed user_id must equal auth.uid().
create or replace function public.create_action_request(
  p_user_id uuid,
  p_series_id uuid,
  p_merchant_key text,
  p_action_type text,
  p_route_type text,
  p_idempotency_key text,
  p_registry_version integer,
  p_pricing_version text
) returns public.action_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.action_requests%rowtype;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'action_request_forbidden';
  end if;

  insert into public.action_requests (
    user_id, series_id, merchant_key, action_type, route_type,
    idempotency_key, registry_version, pricing_version, opened_at
  ) values (
    p_user_id, p_series_id, p_merchant_key, p_action_type, p_route_type,
    p_idempotency_key, p_registry_version, p_pricing_version, now()
  )
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_row;

  if not found then
    select * into v_row
    from public.action_requests
    where user_id = p_user_id
      and idempotency_key = p_idempotency_key;
  end if;

  return v_row;
end;
$$;

-- ============ 10. suppress_failing_routes (auto-suppression) ============
-- Spec §4: a route that fails twice in seven days is automatically
-- suppressed (active=false) pending review. Runs as a scheduled job /
-- service-role call. Restricted to service_role so arbitrary authenticated
-- users cannot flip merchant kill switches.
create or replace function public.suppress_failing_routes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.merchant_registry
  set active = false, updated_at = now()
  where active = true
    and failure_count_7d >= 2;

  get diagnostics v_count = row_count;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.suppress_failing_routes() from public, anon, authenticated;
grant execute on function public.suppress_failing_routes() to service_role;

-- ============ updated_at auto-touch ============
-- 001..004 set updated_at manually in the RPC (save_fire_plan); no shared
-- touch trigger exists yet, so this migration introduces the pattern and
-- applies it to the two tables in this migration that carry updated_at.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_action_requests_updated_at on public.action_requests;
create trigger touch_action_requests_updated_at
  before update on public.action_requests
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_merchant_registry_updated_at on public.merchant_registry;
create trigger touch_merchant_registry_updated_at
  before update on public.merchant_registry
  for each row execute function public.touch_updated_at();
