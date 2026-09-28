-- 013_notification_reads.sql — read tracking for the in-app notification center.
--
-- notification_log was service-role-only by design (the sweep writes it).
-- The notification center needs per-user reads, so this migration adds:
--   1. read_at — NULL = unread. Set when the user opens a row or marks all read.
--   2. RLS policies letting a signed-in user SELECT their own rows and UPDATE
--      their own rows (mark read). INSERT/DELETE stay service-role-only;
--      service role bypasses RLS, so the sweep is unaffected.

alter table public.notification_log add column read_at timestamptz;

create policy "select own notification rows"
  on public.notification_log
  for select
  using (user_id = auth.uid());

create policy "mark own notifications read"
  on public.notification_log
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index notification_log_user_unread_idx
  on public.notification_log (user_id, sent_at desc)
  where read_at is null;
