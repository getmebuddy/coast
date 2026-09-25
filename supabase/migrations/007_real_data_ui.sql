-- 007_real_data_ui.sql — real-data UI milestone (pilot P0).
--
-- Adds the per-user real-data release flag used by the fail-closed rollout:
--   * profiles.real_data_enabled — false by default; the founder enables it
--     per account (founder -> internal pilot -> invited cohort).
--   * The COAST_REAL_DATA=off environment kill switch forces the
--     unavailable state for every signed-in session (never demo fallback).
--
-- Backfill: accounts that already completed a real Plaid sync are founder /
-- test accounts — enable them so the milestone is verifiable on deploy.

alter table public.profiles
  add column if not exists real_data_enabled boolean not null default false;

update public.profiles p
  set real_data_enabled = true
  where exists (
    select 1 from public.plaid_items i
    where i.user_id = p.id and i.status = 'active' and i.last_sync_at is not null
  );
