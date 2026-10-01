-- 014_mcp_oauth.sql — OAuth 2.1 authorization-server storage for the Coast MCP connector.
--
-- Three tables, all service-role-only by design: RLS is enabled with NO
-- policies, so anon/authenticated roles get nothing; the server reads and
-- writes with the service-role key server-side only.
--
-- Only SHA-256 hashes of authorization codes and tokens are stored — never
-- the raw secrets. A leaked database dump yields no usable credentials.

create table public.mcp_oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  client_name text not null default 'Unnamed MCP client',
  redirect_uris text[] not null default '{}',
  client_uri text,
  logo_uri text,
  created_at timestamptz not null default now()
);

create table public.mcp_oauth_codes (
  code_hash text primary key,
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null default 'coast:read',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index mcp_oauth_codes_expiry_idx on public.mcp_oauth_codes (expires_at);

create table public.mcp_oauth_tokens (
  token_hash text primary key,
  kind text not null check (kind in ('access', 'refresh')),
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  scope text not null default 'coast:read',
  expires_at timestamptz not null,
  replaced_at timestamptz,
  created_at timestamptz not null default now()
);
create index mcp_oauth_tokens_user_idx on public.mcp_oauth_tokens (user_id, expires_at);

alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_codes enable row level security;
alter table public.mcp_oauth_tokens enable row level security;
-- No policies: deny all for anon/authenticated. Service role bypasses RLS.
