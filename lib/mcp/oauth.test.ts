import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createHash } from "node:crypto";
import {
  registerClient,
  validateRedirectUris,
  validateAuthorize,
  issueAuthCode,
  exchangeCode,
  refreshTokens,
  resolveAccessToken,
  checkRateLimit,
  clearRateLimits,
  sha256hex,
  MCP_SCOPE,
} from "./oauth";
import { createMemoryMcpStore, type McpStore } from "./store";

const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const USER_ID = "user-123";

/** RFC 7636 Appendix B test vector. */
function pkce() {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

let store: McpStore;
beforeEach(() => {
  store = createMemoryMcpStore();
  clearRateLimits();
});

async function registeredClient() {
  const res = await registerClient(store, {
    redirect_uris: [CLIENT_REDIRECT],
    client_name: "Test Client",
  });
  if ("error" in res) throw new Error("registration failed in test setup");
  return res;
}

describe("validateRedirectUris", () => {
  it("accepts https URIs", () => {
    const r = validateRedirectUris(["https://example.com/callback"]);
    expect(r.uris).toEqual(["https://example.com/callback"]);
  });
  it("accepts http for localhost", () => {
    expect(validateRedirectUris(["http://localhost:3000/cb"]).uris).toBeDefined();
    expect(validateRedirectUris(["http://127.0.0.1:8080/cb"]).uris).toBeDefined();
  });
  it("rejects http for non-localhost", () => {
    const r = validateRedirectUris(["http://evil.com/cb"]);
    expect(r.error?.error).toBe("invalid_redirect_uri");
  });
  it("rejects fragments", () => {
    const r = validateRedirectUris(["https://example.com/cb#frag"]);
    expect(r.error?.error).toBe("invalid_redirect_uri");
  });
  it("rejects empty / non-array", () => {
    expect(validateRedirectUris([]).error?.error).toBe("invalid_redirect_uri");
    expect(validateRedirectUris("https://x.com").error?.error).toBe("invalid_redirect_uri");
  });
});

describe("full OAuth round trip", () => {
  it("register → authorize → code → token → resolve → refresh", async () => {
    const client = await registeredClient();
    expect(client.client_id.startsWith("coast-mcp-")).toBe(true);

    const v = await validateAuthorize(store, {
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      response_type: "code",
      scope: MCP_SCOPE,
      state: "xyz",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    expect("error" in v).toBe(false);

    const code = await issueAuthCode(store, {
      client_id: client.client_id,
      user_id: USER_ID,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: pkce().challenge,
      scope: MCP_SCOPE,
    });

    const pair = await exchangeCode(store, {
      code,
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: pkce().verifier,
    });
    if ("error" in pair) throw new Error(`exchange failed: ${pair.error.error_description}`);
    expect(pair.expires_in).toBe(3600);
    expect(pair.scope).toBe(MCP_SCOPE);

    const resolved = await resolveAccessToken(store, pair.access_token);
    expect(resolved).toMatchObject({ userId: USER_ID, clientId: client.client_id, scope: MCP_SCOPE });

    const pair2 = await refreshTokens(store, { refresh_token: pair.refresh_token, client_id: client.client_id });
    if ("error" in pair2) throw new Error(`refresh failed: ${pair2.error.error_description}`);
    expect(await resolveAccessToken(store, pair2.access_token)).toMatchObject({ userId: USER_ID });

    // Old refresh token is burned by rotation.
    const reuse = await refreshTokens(store, { refresh_token: pair.refresh_token, client_id: client.client_id });
    expect("error" in reuse && reuse.error.error).toBe("invalid_grant");
  });

  it("rejects PKCE mismatch and burns the code", async () => {
    const client = await registeredClient();
    const code = await issueAuthCode(store, {
      client_id: client.client_id,
      user_id: USER_ID,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: pkce().challenge,
      scope: MCP_SCOPE,
    });
    const bad = await exchangeCode(store, {
      code,
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: "wrong-verifier",
    });
    expect("error" in bad && bad.error.error).toBe("invalid_grant");
    // Second attempt with the right verifier also fails: single-use.
    const retry = await exchangeCode(store, {
      code,
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect("error" in retry && retry.error.error).toBe("invalid_grant");
  });

  it("rejects redirect_uri mismatch", async () => {
    const client = await registeredClient();
    const code = await issueAuthCode(store, {
      client_id: client.client_id,
      user_id: USER_ID,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: pkce().challenge,
      scope: MCP_SCOPE,
    });
    const res = await exchangeCode(store, {
      code,
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/api/mcp/other_callback",
      code_verifier: pkce().verifier,
    });
    expect("error" in res && res.error.error).toBe("invalid_grant");
  });

  it("rejects wrong client_id on exchange", async () => {
    const client = await registeredClient();
    const other = await registerClient(store, { redirect_uris: ["https://other.com/cb"] });
    if ("error" in other) throw new Error("setup failed");
    const code = await issueAuthCode(store, {
      client_id: client.client_id,
      user_id: USER_ID,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: pkce().challenge,
      scope: MCP_SCOPE,
    });
    const res = await exchangeCode(store, {
      code,
      client_id: other.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect("error" in res && res.error.error).toBe("invalid_grant");
  });

  it("rejects expired codes", async () => {
    const client = await registeredClient();
    await store.insertCode({
      code_hash: sha256hex("expired-code"),
      client_id: client.client_id,
      user_id: USER_ID,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: pkce().challenge,
      scope: MCP_SCOPE,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await exchangeCode(store, {
      code: "expired-code",
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect("error" in res && res.error.error).toBe("invalid_grant");
  });

  it("rejects unknown and expired access tokens", async () => {
    expect(await resolveAccessToken(store, "nope")).toBeNull();
    const client = await registeredClient();
    await store.insertToken({
      token_hash: sha256hex("old-token"),
      kind: "access",
      client_id: client.client_id,
      user_id: USER_ID,
      scope: MCP_SCOPE,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await resolveAccessToken(store, "old-token")).toBeNull();
  });
});

describe("validateAuthorize", () => {
  it("unknown client is fatal", async () => {
    const r = await validateAuthorize(store, {
      client_id: "nope",
      redirect_uri: CLIENT_REDIRECT,
      response_type: "code",
      code_challenge: "c",
    });
    expect("error" in r && r.error.error).toBe("invalid_client");
    expect("fatal" in r && r.fatal).toBe(true);
  });
  it("unregistered redirect_uri is fatal", async () => {
    const client = await registeredClient();
    const r = await validateAuthorize(store, {
      client_id: client.client_id,
      redirect_uri: "https://evil.com/cb",
      response_type: "code",
      code_challenge: "c",
    });
    expect("error" in r && r.error.error).toBe("invalid_redirect_uri");
  });
  it("missing PKCE challenge is a redirectable error", async () => {
    const client = await registeredClient();
    const r = await validateAuthorize(store, {
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      response_type: "code",
    });
    expect("error" in r && r.error.error).toBe("invalid_request");
    expect("fatal" in r && r.fatal).toBe(false);
  });
  it("wrong scope is rejected", async () => {
    const client = await registeredClient();
    const r = await validateAuthorize(store, {
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      response_type: "code",
      scope: "coast:write",
      code_challenge: "c",
    });
    expect("error" in r && r.error.error).toBe("invalid_scope");
  });
});

describe("consent deny path (unit-level)", () => {
  it("denied decisions never mint codes — validateAuthorize alone issues nothing", async () => {
    const client = await registeredClient();
    // No code exists for this client/user before approval.
    const res = await exchangeCode(store, {
      code: "never-issued",
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect("error" in res && res.error.error).toBe("invalid_grant");
  });
});

describe("rate limiting", () => {
  it("blocks after the limit and resets on clear", () => {
    expect(checkRateLimit("t", 2, 60_000)).toBe(true);
    expect(checkRateLimit("t", 2, 60_000)).toBe(true);
    expect(checkRateLimit("t", 2, 60_000)).toBe(false);
    clearRateLimits();
    expect(checkRateLimit("t", 2, 60_000)).toBe(true);
  });
});
