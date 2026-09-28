-- 012_push_subscriptions.sql — web-push subscriptions (one row per browser/device).
--
-- A push subscription belongs to exactly one browser endpoint. The
-- service-role sweep reads all of a user's rows and deletes the ones the
-- push service reports as expired (404/410). Users manage only their own
-- rows; the sweep (service role) bypasses RLS.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, endpoint)
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
create policy "own rows" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
