-- 002_account_enrichment.sql
-- Real Plaid account metadata on the accounts table, plus prev_amount_cents
-- on recurring for the price-change watch.
-- Safe to run on top of 001: every statement is IF NOT EXISTS-guarded.
-- (The user already ran 001 in Supabase; run this one next in the SQL editor.)

alter table public.accounts add column if not exists plaid_account_id text;
alter table public.accounts add column if not exists official_name text;
alter table public.accounts add column if not exists subtype text;
alter table public.accounts add column if not exists mask text;
alter table public.accounts add column if not exists available_cents integer;
alter table public.accounts add column if not exists updated_at timestamptz not null default now();

-- One row per (user, Plaid account). NULL plaid_account_id never conflicts
-- (Postgres treats NULLs as distinct), so manual accounts are unaffected.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'accounts_user_plaid_account_id_key'
  ) then
    alter table public.accounts
      add constraint accounts_user_plaid_account_id_key unique (user_id, plaid_account_id);
  end if;
end $$;

alter table public.recurring add column if not exists prev_amount_cents integer;

comment on column public.accounts.type is 'checking | savings | credit | investment | loan | manual';
comment on column public.accounts.balance_cents is 'Plaid balances.current in integer cents, verbatim (for credit accounts a positive value is the amount owed, per Plaid convention)';
comment on column public.accounts.plaid_account_id is 'Plaid account_id. Stable dedupe key for account enrichment upserts.';
comment on column public.recurring.prev_amount_cents is 'Charge amount before the most recent price change, when price_changed is true.';
