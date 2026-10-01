# Coast MCP Server

Remote, read-only MCP server + OAuth 2.1 authorization server so Claude and
ChatGPT can connect to Coast. **Build + deploy only** — no directory
submissions, no public listing, no announcement (those need Vivek's explicit
go-ahead; see the checklist at the bottom).

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 discovery: issuer, authorize/token/register URLs, `scopes_supported: ["coast:read"]`, PKCE S256 required |
| `POST /oauth/register` | Dynamic client registration (RFC 7591). Validates `redirect_uris` (https only; http allowed for localhost; no fragments). Returns `client_id` (public client, PKCE required). Rate-limited: 10/min/IP |
| `GET /oauth/authorize` | Authorization endpoint. Requires a signed-in Coast user — signed-out users are routed through `/login?next=…` and resume. Renders a consent screen (client name, `coast:read` scope, approve/deny). CSRF-protected via httpOnly cookie |
| `POST /oauth/authorize` | Processes the consent decision. On approve: issues a single-use authorization code (10-min TTL, bound to client_id + exact redirect_uri + code_challenge) and redirects to the client's redirect URI |
| `POST /oauth/token` | `authorization_code` grant (verifies code unused/unexpired, exact redirect_uri match, PKCE S256 verifier) → `access_token` (opaque, 1h TTL) + `refresh_token` (30d, rotated on every use). `refresh_token` grant supported. Rate-limited: 30/min/IP |
| `POST /mcp`, `GET /mcp` | Streamable-HTTP MCP endpoint (stateless, SDK `WebStandardStreamableHTTPServerTransport`). No token → `401` + `WWW-Authenticate: Bearer`. Invalid/expired token → `401`. Valid token but real data disabled → `403` |

## Tools (all `readOnlyHint: true`)

1. `get_number` — The Number + trajectory summary. No account identifiers.
2. `get_budget_status` — current budget month: ceiling, spent, pace, per-category totals. Aggregates only.
3. `get_attention_list` — Morning Brief attention items (title, detail, impact, `/brief` deep link). No transaction rows.
4. `get_spending_summary` — current-month category totals. Aggregates only; per-transaction rows deliberately stripped.

Forbidden by design: transaction detail, account numbers (never selected), any write/action tool, any recommendation/advice wording. Server instructions frame all data as educational, not financial advice.

## Security model

- **Token → user resolution**: every `/mcp` request resolves the Bearer token to a user id via `lib/mcp/oauth.ts#resolveAccessToken`, then builds a `Viewer` and queries under that identity. Every query filters by `user_id`.
- **Secret storage**: only SHA-256 hashes of codes/tokens are persisted. Raw secrets exist only in transit.
- **Database**: `mcp_oauth_clients`, `mcp_oauth_codes`, `mcp_oauth_tokens` (migration `014_mcp_oauth.sql`). RLS enabled with **no policies** — deny-all for anon/authenticated; the server uses the service-role key server-side only.
- **Codes**: single-use (atomic mark-used; a failed PKCE check burns the code), 10-min TTL, bound to client_id + exact redirect_uri + challenge.
- **Refresh rotation**: each refresh invalidates the old refresh token.
- **redirect_uri**: exact-match against registered values on authorize *and* token calls.
- **Rate limits**: in-memory per-IP buckets on `/oauth/register` and `/oauth/token` (per serverless instance).
- **No-demo guard**: every MCP tool response passes `guardNoDemo` — demo provenance can never leak into connector responses (mirrors the web fail-closed rule).

## Reused internals

The tools reuse the web loaders with an injected DB client (`loadBudgetMonth`, `loadSpending`, `listOpenFindings`, all accepting an optional `DbClient` that defaults to the session client). The MCP path passes the service-role client; every loader filters by `viewer.userId`, so RLS bypass is safe.

## Testing

`lib/mcp/oauth.test.ts` (17 tests): full round trip register → authorize → code → token → refresh; PKCE mismatch burns the code; redirect_uri/client mismatches rejected; code reuse and expiry rejected; authorize validation (fatal vs redirectable errors); rate limits.

`lib/mcp/handler.test.ts` (8 tests): `/mcp` without token → 401 + `WWW-Authenticate`; bad/expired token → 401; real-data-disabled → 403; initialize handshake returns server info + read-only instructions; `tools/list` returns exactly the four tools, all `readOnlyHint`; tool descriptions contain no advice wording; no-demo guard unit tests.

## Before public listing — NOT DONE

- [ ] Privacy policy URL + Terms of Service (ChatGPT review rejects incomplete ones)
- [ ] Legal review of the connector scope (read-only, educational framing)
- [ ] Test account credentials for directory reviewers (no MFA)
- [ ] Demo video + listing assets (icon, screenshots, subtitle copy, starter prompts)
- [ ] Submit to ChatGPT App Directory / Claude Marketplace (Vivek approval required)
- [ ] "Works with ChatGPT/Claude" site badges + in-app "Ask your AI assistant" entry point
- [ ] Retention gate cleared (D30 ≥50% activated / ≥40% resolve attention item in 14 days / Brief opened ≥3×/week median) before any launch
- [ ] Third-party directory listings (Smithery, Glama, mcp.so)
- [ ] Open-source the MCP server on GitHub (trust pitch for a finance product)
