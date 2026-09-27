-- Merchant logos (Plaid `logo_url`, 100x100 PNG) captured at sync time.
-- Nullable by design: historical rows keep NULL until a later sync backfills
-- them; the client renders a letter avatar whenever no logo is stored.
alter table public.transactions add column if not exists logo_url text;
