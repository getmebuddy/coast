-- 004_whatif_planner.sql — What-If Planner persistence
-- Extends fire_settings with versioning + model metadata, adds the
-- user-owned scenarios table, and provides an atomic save_fire_plan RPC
-- (settings update + active scenario + audit event in one transaction).

-- ============ extend fire_settings ============
alter table public.fire_settings
  add column if not exists settings_version integer not null default 1,
  add column if not exists calculation_version text not null default 'fire-monthly-v1',
  add column if not exists return_basis text not null default 'nominal',
  add column if not exists target_mode text not null default 'auto';

-- ============ saved scenarios ============
create table if not exists public.fire_scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text,
  inputs jsonb not null,
  result jsonb not null,
  calculation_version text not null default 'fire-monthly-v1',
  baseline_version integer not null,
  is_active_plan boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fire_scenarios enable row level security;

drop policy if exists "own rows" on public.fire_scenarios;
create policy "own rows" on public.fire_scenarios
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists fire_scenarios_user_idx on public.fire_scenarios (user_id);

-- ============ atomic save ============
-- Updates settings with optimistic concurrency (expected version must match),
-- replaces the active plan scenario, and writes an audit event — atomically.
-- Raises 'fire_plan_conflict' when the stored version moved (or a settings
-- row appeared concurrently on first save). Raises 'fire_plan_invalid'
-- when inputs fail range validation.
create or replace function public.save_fire_plan(
  p_annual_spending_cents integer,
  p_portfolio_cents integer,
  p_monthly_savings_cents integer,
  p_expected_return_pct numeric,
  p_target_number_cents integer,
  p_target_mode text,
  p_calculation_version text,
  p_expected_version integer,
  p_scenario_name text,
  p_scenario_inputs jsonb,
  p_scenario_result jsonb,
  p_changed_fields text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.fire_settings%rowtype;
begin
  if v_uid is null then
    raise exception 'fire_plan_unauthorized';
  end if;

  -- range validation mirrors the shared client/server contract
  if p_annual_spending_cents < 1_000_00 or p_annual_spending_cents > 360_000_00 then
    raise exception 'fire_plan_invalid: annual_spending';
  end if;
  if p_portfolio_cents < 0 or p_portfolio_cents > 2_000_000_000 then
    raise exception 'fire_plan_invalid: portfolio';
  end if;
  if p_monthly_savings_cents < 0 or p_monthly_savings_cents > 2_500_000 then
    raise exception 'fire_plan_invalid: monthly_savings';
  end if;
  if p_expected_return_pct < 0 or p_expected_return_pct > 12 then
    raise exception 'fire_plan_invalid: expected_return';
  end if;
  if p_target_number_cents is not null and p_target_number_cents <= 0 then
    raise exception 'fire_plan_invalid: target';
  end if;
  if p_target_mode not in ('auto', 'custom') then
    raise exception 'fire_plan_invalid: target_mode';
  end if;
  if p_calculation_version <> 'fire-monthly-v1' then
    raise exception 'fire_plan_invalid: calculation_version';
  end if;

  if p_expected_version = 0 then
    -- first save: insert, but lose a race cleanly
    insert into public.fire_settings (
      user_id, annual_spending_cents, portfolio_cents, monthly_savings_cents,
      expected_return_pct, target_number_cents, target_mode,
      settings_version, calculation_version, return_basis
    ) values (
      v_uid, p_annual_spending_cents, p_portfolio_cents, p_monthly_savings_cents,
      p_expected_return_pct, p_target_number_cents, p_target_mode,
      1, p_calculation_version, 'nominal'
    )
    on conflict (user_id) do nothing
    returning * into v_row;
    if not found then
      raise exception 'fire_plan_conflict';
    end if;
  else
    update public.fire_settings set
      annual_spending_cents = p_annual_spending_cents,
      portfolio_cents = p_portfolio_cents,
      monthly_savings_cents = p_monthly_savings_cents,
      expected_return_pct = p_expected_return_pct,
      target_number_cents = p_target_number_cents,
      target_mode = p_target_mode,
      calculation_version = p_calculation_version,
      settings_version = p_expected_version + 1,
      updated_at = now()
    where user_id = v_uid and settings_version = p_expected_version
    returning * into v_row;
    if not found then
      raise exception 'fire_plan_conflict';
    end if;
  end if;

  -- replace the active plan scenario (v1 persists only the active one)
  delete from public.fire_scenarios where user_id = v_uid and is_active_plan = true;
  insert into public.fire_scenarios (
    user_id, name, inputs, result, calculation_version, baseline_version, is_active_plan
  ) values (
    v_uid, nullif(p_scenario_name, ''), p_scenario_inputs, p_scenario_result,
    p_calculation_version, v_row.settings_version, true
  );

  -- audit: field names + calculation version only, never balances
  insert into public.audit_log (user_id, action, details) values (
    v_uid,
    'fire_plan_saved',
    jsonb_build_object(
      'changed_fields', coalesce(p_changed_fields, array[]::text[]),
      'calculation_version', p_calculation_version
    )
  );

  return to_jsonb(v_row);
end;
$$;
