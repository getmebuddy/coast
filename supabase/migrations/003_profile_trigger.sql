-- 003_profile_trigger.sql — auto-create public.profiles rows for new auth users.
--
-- Every app table's user_id references public.profiles(id). Without this
-- trigger, a fresh sign-up has no profile row and the first user-scoped
-- insert (Plaid connect, Brief read-state, budgets, …) fails with
--   23503 insert or update on table "plaid_items" violates foreign key constraint
-- The app also carries an ensure-profile backstop in the auth callback and
-- the Plaid exchange route; this trigger is the primary mechanism.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: users created before this trigger existed.
insert into public.profiles (id)
select u.id
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;
