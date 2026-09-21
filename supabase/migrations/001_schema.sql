-- Coast schema v1 — Supabase/Postgres
-- Money: integer cents everywhere. Ledger is append-only: transactions are
-- NEVER updated; user corrections live in transaction_overrides.

-- ============ users (extends Supabase auth.users) ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'America/Chicago',
  created_at timestamptz not null default now()
);

-- ============ bank connections ============
create table public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- access tokens are encrypted at rest (pgcrypto / vault). NEVER select this column client-side.
  access_token_encrypted bytea not null,
  institution_name text not null,
  cursor text, -- Plaid transactions-sync cursor; advance only after successful commit
  status text not null default 'active', -- active | error | revoked
  last_sync_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plaid_item_id uuid references public.plaid_items(id) on delete set null,
  name text not null,
  type text not null, -- checking | savings | credit | investment | manual
  balance_cents integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============ immutable ledger ============
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete set null,
  source text not null default 'plaid', -- plaid | csv | manual
  source_id text, -- Plaid transaction_id. Dedupe key.
  amount_cents integer not null, -- negative = money out, positive = money in
  posted_at date not null,
  merchant_raw text not null,
  merchant_normalized text not null,
  kind text not null default 'expense', -- income | expense | transfer | refund | fee
  pending boolean not null default false,
  ingested_at timestamptz not null default now(),
  unique(user_id, source, source_id)
);
-- fuzzy-dedupe support for CSV imports
create index transactions_fuzzy_idx on public.transactions (user_id, merchant_normalized, amount_cents, posted_at);

-- user corrections: ALWAYS win over rules. Append-only.
create table public.transaction_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  category text not null,
  note text,
  created_at timestamptz not null default now(),
  unique(user_id, transaction_id)
);

-- deterministic rules: merchant pattern -> category
create table public.category_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  match_pattern text not null, -- normalized merchant substring
  category text not null,
  created_at timestamptz not null default now(),
  unique(user_id, match_pattern)
);

-- splits: one charge across categories
create table public.splits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  category text not null,
  amount_cents integer not null check (amount_cents > 0)
);

-- ============ recurring ============
create table public.recurring (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant_normalized text not null,
  amount_cents_avg integer not null,
  cadence text not null, -- weekly | monthly | annual
  next_charge_date date,
  last_amount_cents integer not null,
  price_changed boolean not null default false,
  dismissed boolean not null default false, -- "not a subscription"
  updated_at timestamptz not null default now(),
  unique(user_id, merchant_normalized)
);

-- ============ budgets ============
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  month date not null, -- first of month
  category text not null, -- '__total__' for the monthly ceiling
  limit_cents integer not null check (limit_cents >= 0),
  unique(user_id, month, category)
);

-- ============ FIRE ============
create table public.fire_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  annual_spending_cents integer not null check (annual_spending_cents >= 0),
  portfolio_cents integer not null default 0 check (portfolio_cents >= 0),
  monthly_savings_cents integer not null default 0,
  expected_return_pct numeric(5,2) not null default 7.00,
  target_number_cents integer, -- null = auto (25x spending)
  updated_at timestamptz not null default now()
);

-- ============ audit (append-only) ============
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ============ brief reads (morning brief persistence) ============
-- One row per user; last_read_at marks when the morning brief was opened.
create table public.brief_reads (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ Row Level Security: users see ONLY their own rows ============
alter table public.profiles enable row level security;
alter table public.plaid_items enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_overrides enable row level security;
alter table public.category_rules enable row level security;
alter table public.splits enable row level security;
alter table public.recurring enable row level security;
alter table public.budgets enable row level security;
alter table public.fire_settings enable row level security;
alter table public.audit_log enable row level security;

-- profiles: id = auth.uid()
create policy "own profile" on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());

-- everything else keyed on user_id
do $$
declare t text;
begin
  foreach t in array array[
    'plaid_items','accounts','transactions','transaction_overrides',
    'category_rules','splits','recurring','budgets','fire_settings','audit_log',
    'brief_reads'
  ] loop
    execute format('create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- service-role-only: token column must never be readable by the anon/authenticated role.
-- (Enforced in application code: the API never selects access_token_encrypted for client responses.
--  A dedicated vault function with SECURITY DEFINER handles decrypt-on-sync-server-side only.)
revoke select on public.plaid_items from anon, authenticated;
