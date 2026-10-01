/**
 * OAuth 2.1 authorization-server logic for the Coast MCP connector.
 *
 * Pure-ish functions over an McpStore (injectable for tests). Route handlers
 * in app/oauth/* and app/.well-known/* are thin wrappers.
 *
 * Security properties:
 *  - Public clients only; PKCE S256 is REQUIRED (no client_secret).
 *  - Authorization codes: single-use (atomic mark), 10-minute TTL, bound to
 *    client_id + exact redirect_uri + code_challenge.
 *  - redirect_uri must exactly match a registered value on every use.
 *  - Access tokens: opaque random, 1h TTL. Refresh tokens: 30d TTL, rotated
 *    on every use (old refresh token is invalidated).
 *  - Only SHA-256 hashes are persisted; raw secrets never touch the store.
 */
import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { McpStore } from "./store";

export const MCP_SCOPE = "coast:read";
export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function b64urlSha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("base64url");
}

/** Constant-time string comparison (length-guarded). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface OAuthError {
  error: string;
  error_description: string;
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

export interface RegisterInput {
  redirect_uris?: unknown;
  client_name?: unknown;
  client_uri?: unknown;
  logo_uri?: unknown;
}

/** Validate a redirect URI list. https required; http allowed only for localhost. */
export function validateRedirectUris(value: unknown): { uris?: string[]; error?: OAuthError } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: { error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array." } };
  }
  const uris: string[] = [];
  for (const u of value) {
    if (typeof u !== "string") {
      return { error: { error: "invalid_redirect_uri", error_description: "redirect_uris must contain only strings." } };
    }
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return { error: { error: "invalid_redirect_uri", error_description: `Malformed redirect URI: ${u}` } };
    }
    if (parsed.hash) {
      return { error: { error: "invalid_redirect_uri", error_description: `Redirect URI must not contain a fragment: ${u}` } };
    }
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol === "https:") {
      uris.push(parsed.toString());
    } else if (parsed.protocol === "http:" && isLocalhost) {
      uris.push(parsed.toString());
    } else {
      return {
        error: { error: "invalid_redirect_uri", error_description: `Redirect URI must use https (http allowed only for localhost): ${u}` },
      };
    }
  }
  return { uris };
}

function cleanString(value: unknown, maxLen: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t || t.length > maxLen) return null;
  return t;
}

export async function registerClient(
  store: McpStore,
  input: RegisterInput
): Promise<{ client_id: string; client_name: string; redirect_uris: string[] } | { error: OAuthError }> {
  const { uris, error } = validateRedirectUris(input.redirect_uris);
  if (error) return { error };
  const client_id = `coast-mcp-${randomBytes(12).toString("base64url")}`;
  const client_name = cleanString(input.client_name, 120) ?? "Unnamed MCP client";
  const client_uri = cleanString(input.client_uri, 500);
  const logo_uri = cleanString(input.logo_uri, 500);
  if (client_uri) {
    try {
      new URL(client_uri);
    } catch {
      return { error: { error: "invalid_client_metadata", error_description: "client_uri must be a valid URL." } };
    }
  }
  if (logo_uri) {
    try {
      new URL(logo_uri);
    } catch {
      return { error: { error: "invalid_client_metadata", error_description: "logo_uri must be a valid URL." } };
    }
  }
  await store.insertClient({ client_id, client_name, redirect_uris: uris!, client_uri, logo_uri });
  return { client_id, client_name, redirect_uris: uris! };
}

// ---------------------------------------------------------------------------
// Authorization endpoint helpers
// ---------------------------------------------------------------------------

export interface AuthorizeParams {
  client_id?: string | null;
  redirect_uri?: string | null;
  response_type?: string | null;
  scope?: string | null;
  state?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
}

/** Validate /oauth/authorize parameters. Returns the client + normalized scope, or an error. */
export async function validateAuthorize(
  store: McpStore,
  p: AuthorizeParams
): Promise<{ client_id: string; client_name: string; redirect_uri: string; scope: string; state: string } | { error: OAuthError; fatal: boolean }> {
  const client = p.client_id ? await store.getClient(p.client_id) : null;
  // Client or redirect_uri problems are fatal: we cannot safely redirect anywhere.
  if (!client) return { error: { error: "invalid_client", error_description: "Unknown client_id." }, fatal: true };
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) {
    return { error: { error: "invalid_redirect_uri", error_description: "redirect_uri is not registered for this client." }, fatal: true };
  }
  const redirect_uri = p.redirect_uri;
  const deny = (error: OAuthError) => ({ error, fatal: false });
  if (p.response_type !== "code") return deny({ error: "unsupported_response_type", error_description: "Only response_type=code is supported." });
  const scope = (p.scope ?? MCP_SCOPE).trim();
  if (scope !== MCP_SCOPE) return deny({ error: "invalid_scope", error_description: `Only scope "${MCP_SCOPE}" is supported.` });
  if (!p.code_challenge) return deny({ error: "invalid_request", error_description: "code_challenge is required (PKCE S256)." });
  if (p.code_challenge_method && p.code_challenge_method !== "S256") {
    return deny({ error: "invalid_request", error_description: "Only code_challenge_method=S256 is supported." });
  }
  return { client_id: client.client_id, client_name: client.client_name, redirect_uri, scope, state: p.state ?? "" };
}

export async function issueAuthCode(
  store: McpStore,
  args: { client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string }
): Promise<string> {
  const code = `coast-ac-${randomSecret()}`;
  await store.insertCode({
    code_hash: sha256hex(code),
    client_id: args.client_id,
    user_id: args.user_id,
    redirect_uri: args.redirect_uri,
    code_challenge: args.code_challenge,
    scope: args.scope,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  return code;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

async function mintTokenPair(
  store: McpStore,
  args: { client_id: string; user_id: string; scope: string }
): Promise<TokenPair> {
  const access_token = `coast-at-${randomSecret()}`;
  const refresh_token = `coast-rt-${randomSecret()}`;
  const now = Date.now();
  await store.insertToken({
    token_hash: sha256hex(access_token),
    kind: "access",
    client_id: args.client_id,
    user_id: args.user_id,
    scope: args.scope,
    expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
  });
  await store.insertToken({
    token_hash: sha256hex(refresh_token),
    kind: "refresh",
    client_id: args.client_id,
    user_id: args.user_id,
    scope: args.scope,
    expires_at: new Date(now + REFRESH_TTL_MS).toISOString(),
  });
  return { access_token, refresh_token, expires_in: ACCESS_TTL_MS / 1000, scope: args.scope };
}

export interface CodeExchangeInput {
  code?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_verifier?: string | null;
}

export async function exchangeCode(
  store: McpStore,
  input: CodeExchangeInput
): Promise<TokenPair | { error: OAuthError }> {
  const fail = (error: string, error_description: string): { error: OAuthError } => ({ error: { error, error_description } });
  if (!input.code || !input.client_id || !input.redirect_uri || !input.code_verifier) {
    return fail("invalid_request", "code, client_id, redirect_uri and code_verifier are required.");
  }
  const row = await store.getCode(sha256hex(input.code));
  if (!row) return fail("invalid_grant", "Authorization code not recognized.");
  if (row.used_at) return fail("invalid_grant", "Authorization code already used.");
  if (Date.parse(row.expires_at) <= Date.now()) return fail("invalid_grant", "Authorization code expired.");
  if (row.client_id !== input.client_id) return fail("invalid_grant", "Authorization code was issued to a different client.");
  if (!safeEqual(row.redirect_uri, input.redirect_uri)) {
    return fail("invalid_grant", "redirect_uri does not match the authorization request.");
  }
  // Mark used BEFORE verifying PKCE so a wrong verifier also burns the code.
  const marked = await store.markCodeUsed(sha256hex(input.code));
  if (!marked) return fail("invalid_grant", "Authorization code already used.");
  if (!safeEqual(row.code_challenge, b64urlSha256(input.code_verifier))) {
    return fail("invalid_grant", "PKCE code_verifier does not match code_challenge.");
  }
  return mintTokenPair(store, { client_id: row.client_id, user_id: row.user_id, scope: row.scope });
}

export interface RefreshInput {
  refresh_token?: string | null;
  client_id?: string | null;
}

export async function refreshTokens(
  store: McpStore,
  input: RefreshInput
): Promise<TokenPair | { error: OAuthError }> {
  const fail = (error: string, error_description: string): { error: OAuthError } => ({ error: { error, error_description } });
  if (!input.refresh_token || !input.client_id) {
    return fail("invalid_request", "refresh_token and client_id are required.");
  }
  const row = await store.getToken(sha256hex(input.refresh_token));
  if (!row || row.kind !== "refresh") return fail("invalid_grant", "Refresh token not recognized.");
  if (row.replaced_at) return fail("invalid_grant", "Refresh token already rotated.");
  if (Date.parse(row.expires_at) <= Date.now()) return fail("invalid_grant", "Refresh token expired.");
  if (row.client_id !== input.client_id) return fail("invalid_grant", "Refresh token was issued to a different client.");
  await store.markTokenReplaced(sha256hex(input.refresh_token));
  return mintTokenPair(store, { client_id: row.client_id, user_id: row.user_id, scope: row.scope });
}

// ---------------------------------------------------------------------------
// Token resolution for /mcp
// ---------------------------------------------------------------------------

export interface ResolvedToken {
  userId: string;
  clientId: string;
  scope: string;
}

export async function resolveAccessToken(store: McpStore, rawToken: string): Promise<ResolvedToken | null> {
  const row = await store.getToken(sha256hex(rawToken));
  if (!row || row.kind !== "access") return null;
  if (row.replaced_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return { userId: row.user_id, clientId: row.client_id, scope: row.scope };
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory; per serverless instance)
// ---------------------------------------------------------------------------

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Sliding-window-ish counter. Returns true when the request is allowed. */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

/** Test hook: clear all buckets. */
export function clearRateLimits(): void {
  buckets.clear();
}
