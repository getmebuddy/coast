/**
 * MCP OAuth storage — interface plus Supabase and in-memory implementations.
 *
 * Only SHA-256 hashes of authorization codes and tokens are ever persisted;
 * raw secrets exist only in transit (redirect URLs, token responses).
 * The Supabase tables are RLS-deny-all; only the service-role client (used
 * server-side) can read/write them.
 */
import "server-only";
import { createServiceSupabase } from "@/lib/supabase/server";

export interface McpClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  client_uri: string | null;
  logo_uri: string | null;
  created_at: string;
}

export interface McpClientInput {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  client_uri?: string | null;
  logo_uri?: string | null;
}

export interface McpCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  expires_at: string;
  used_at: string | null;
}

export interface McpCodeInput {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  expires_at: string;
}

export interface McpTokenRow {
  token_hash: string;
  kind: "access" | "refresh";
  client_id: string;
  user_id: string;
  scope: string;
  expires_at: string;
  replaced_at: string | null;
}

export interface McpTokenInput {
  token_hash: string;
  kind: "access" | "refresh";
  client_id: string;
  user_id: string;
  scope: string;
  expires_at: string;
}

export interface McpStore {
  insertClient(input: McpClientInput): Promise<void>;
  getClient(client_id: string): Promise<McpClientRow | null>;
  insertCode(input: McpCodeInput): Promise<void>;
  getCode(code_hash: string): Promise<McpCodeRow | null>;
  /** Atomically mark a code used; false when already used (prevents replay). */
  markCodeUsed(code_hash: string): Promise<boolean>;
  insertToken(input: McpTokenInput): Promise<void>;
  getToken(token_hash: string): Promise<McpTokenRow | null>;
  markTokenReplaced(token_hash: string): Promise<void>;
  deleteExpiredCodes(): Promise<void>;
  deleteExpiredTokens(): Promise<void>;
}

/** Production store — service-role client, server-side only. */
export function createSupabaseMcpStore(): McpStore {
  const db = () => createServiceSupabase();
  return {
    async insertClient(input) {
      const { error } = await db().from("mcp_oauth_clients").insert({
        client_id: input.client_id,
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
        client_uri: input.client_uri ?? null,
        logo_uri: input.logo_uri ?? null,
      });
      if (error) throw new Error(`mcp-store: insertClient: ${error.message}`);
    },
    async getClient(client_id) {
      const { data, error } = await db()
        .from("mcp_oauth_clients")
        .select("client_id, client_name, redirect_uris, client_uri, logo_uri, created_at")
        .eq("client_id", client_id)
        .maybeSingle();
      if (error) throw new Error(`mcp-store: getClient: ${error.message}`);
      return (data as McpClientRow | null) ?? null;
    },
    async insertCode(input) {
      const { error } = await db().from("mcp_oauth_codes").insert({
        code_hash: input.code_hash,
        client_id: input.client_id,
        user_id: input.user_id,
        redirect_uri: input.redirect_uri,
        code_challenge: input.code_challenge,
        scope: input.scope,
        expires_at: input.expires_at,
      });
      if (error) throw new Error(`mcp-store: insertCode: ${error.message}`);
    },
    async getCode(code_hash) {
      const { data, error } = await db()
        .from("mcp_oauth_codes")
        .select("code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, used_at")
        .eq("code_hash", code_hash)
        .maybeSingle();
      if (error) throw new Error(`mcp-store: getCode: ${error.message}`);
      return (data as McpCodeRow | null) ?? null;
    },
    async markCodeUsed(code_hash) {
      const { data, error } = await db()
        .from("mcp_oauth_codes")
        .update({ used_at: new Date().toISOString() })
        .eq("code_hash", code_hash)
        .is("used_at", null)
        .select("code_hash");
      if (error) throw new Error(`mcp-store: markCodeUsed: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async insertToken(input) {
      const { error } = await db().from("mcp_oauth_tokens").insert({
        token_hash: input.token_hash,
        kind: input.kind,
        client_id: input.client_id,
        user_id: input.user_id,
        scope: input.scope,
        expires_at: input.expires_at,
      });
      if (error) throw new Error(`mcp-store: insertToken: ${error.message}`);
    },
    async getToken(token_hash) {
      const { data, error } = await db()
        .from("mcp_oauth_tokens")
        .select("token_hash, kind, client_id, user_id, scope, expires_at, replaced_at")
        .eq("token_hash", token_hash)
        .maybeSingle();
      if (error) throw new Error(`mcp-store: getToken: ${error.message}`);
      return (data as McpTokenRow | null) ?? null;
    },
    async markTokenReplaced(token_hash) {
      const { error } = await db()
        .from("mcp_oauth_tokens")
        .update({ replaced_at: new Date().toISOString() })
        .eq("token_hash", token_hash);
      if (error) throw new Error(`mcp-store: markTokenReplaced: ${error.message}`);
    },
    async deleteExpiredCodes() {
      const { error } = await db().from("mcp_oauth_codes").delete().lt("expires_at", new Date().toISOString());
      if (error) throw new Error(`mcp-store: deleteExpiredCodes: ${error.message}`);
    },
    async deleteExpiredTokens() {
      const { error } = await db()
        .from("mcp_oauth_tokens")
        .delete()
        .lt("expires_at", new Date(Date.now() - 7 * 86400_000).toISOString());
      if (error) throw new Error(`mcp-store: deleteExpiredTokens: ${error.message}`);
    },
  };
}

/** In-memory store for tests. */
export function createMemoryMcpStore(): McpStore {
  const clients = new Map<string, McpClientRow>();
  const codes = new Map<string, McpCodeRow>();
  const tokens = new Map<string, McpTokenRow>();
  const now = () => new Date().toISOString();
  return {
    async insertClient(input) {
      if (clients.has(input.client_id)) throw new Error("mcp-store: duplicate client_id");
      clients.set(input.client_id, {
        client_id: input.client_id,
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
        client_uri: input.client_uri ?? null,
        logo_uri: input.logo_uri ?? null,
        created_at: now(),
      });
    },
    async getClient(client_id) {
      return clients.get(client_id) ?? null;
    },
    async insertCode(input) {
      codes.set(input.code_hash, { ...input, used_at: null });
    },
    async getCode(code_hash) {
      return codes.get(code_hash) ?? null;
    },
    async markCodeUsed(code_hash) {
      const row = codes.get(code_hash);
      if (!row || row.used_at) return false;
      row.used_at = now();
      return true;
    },
    async insertToken(input) {
      tokens.set(input.token_hash, { ...input, replaced_at: null });
    },
    async getToken(token_hash) {
      return tokens.get(token_hash) ?? null;
    },
    async markTokenReplaced(token_hash) {
      const row = tokens.get(token_hash);
      if (row) row.replaced_at = now();
    },
    async deleteExpiredCodes() {
      const t = now();
      for (const [k, v] of codes) if (v.expires_at < t) codes.delete(k);
    },
    async deleteExpiredTokens() {
      const t = new Date(Date.now() - 7 * 86400_000).toISOString();
      for (const [k, v] of tokens) if (v.expires_at < t) tokens.delete(k);
    },
  };
}
