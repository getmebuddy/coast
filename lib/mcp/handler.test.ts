import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { handleMcpRequest, type McpDeps } from "./handler";
import { createMemoryMcpStore } from "./store";
import { sha256hex } from "./oauth";
import { MCP_TOOLS, guardNoDemo } from "./tools";

const USER_ID = "mcp-test-user";

function depsWithToken(token: string, realDataEnabled = true): McpDeps {
  const store = createMemoryMcpStore();
  return {
    store,
    resolveViewer: async (userId: string) =>
      userId === USER_ID
        ? { userId, email: null, timezone: "America/Chicago", realDataEnabled }
        : null,
  };
}

async function seedAccessToken(store: ReturnType<typeof createMemoryMcpStore>, raw: string) {
  await store.insertToken({
    token_hash: sha256hex(raw),
    kind: "access",
    client_id: "coast-mcp-test",
    user_id: USER_ID,
    scope: "coast:read",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
}

function rpcRequest(id: number | string, method: string, params: unknown, token?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

/** Parse SSE `data:` frames from a transport response into JSON-RPC messages. */
async function readSseMessages(res: Response): Promise<any[]> {
  const text = await res.text();
  const out: any[] = [];
  for (const chunk of text.split("\n\n")) {
    for (const line of chunk.split("\n")) {
      const t = line.trim();
      if (t.startsWith("data:")) {
        const payload = t.slice(5).trim();
        if (payload && payload !== "[DONE]") out.push(JSON.parse(payload));
      }
    }
  }
  return out;
}

describe("/mcp authentication", () => {
  it("rejects requests without a token with 401 + WWW-Authenticate", async () => {
    const deps = depsWithToken("unused");
    const res = await handleMcpRequest(rpcRequest(1, "initialize", {}), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate") ?? "").toContain("Bearer");
  });

  it("rejects unknown tokens", async () => {
    const deps = depsWithToken("unused");
    const res = await handleMcpRequest(rpcRequest(1, "initialize", {}, "bogus-token"), deps);
    expect(res.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const store = createMemoryMcpStore();
    await store.insertToken({
      token_hash: sha256hex("old"),
      kind: "access",
      client_id: "c",
      user_id: USER_ID,
      scope: "coast:read",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const deps: McpDeps = { store, resolveViewer: async () => null };
    const res = await handleMcpRequest(rpcRequest(1, "initialize", {}, "old"), deps);
    expect(res.status).toBe(401);
  });

  it("returns 403 when the account has real data disabled", async () => {
    const deps = depsWithToken("tok403", false);
    await seedAccessToken(deps.store, "tok403");
    const res = await handleMcpRequest(rpcRequest(1, "initialize", {}, "tok403"), deps);
    expect(res.status).toBe(403);
  });
});

describe("/mcp protocol", () => {
  let deps: McpDeps;
  const TOKEN = "valid-token-1";
  beforeEach(async () => {
    deps = depsWithToken(TOKEN);
    await seedAccessToken(deps.store, TOKEN);
  });

  it("answers initialize with server info and instructions", async () => {
    const res = await handleMcpRequest(
      rpcRequest(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }, TOKEN),
      deps
    );
    expect(res.status).toBe(200);
    const [msg] = await readSseMessages(res);
    expect(msg.result.serverInfo.name).toBe("coast");
    expect(msg.result.instructions).toContain("read-only");
    expect(msg.result.instructions.toLowerCase()).toContain("never financial advice");
  });

  it("lists exactly the four read-only tools", async () => {
    const res = await handleMcpRequest(rpcRequest(2, "tools/list", {}, TOKEN), deps);
    expect(res.status).toBe(200);
    const [msg] = await readSseMessages(res);
    const names = msg.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["get_attention_list", "get_budget_status", "get_number", "get_spending_summary"]);
    for (const t of msg.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.description.toLowerCase()).not.toContain("you should");
      expect(t.description.toLowerCase()).not.toContain("recommend");
    }
  });
});

describe("tool registry invariants", () => {
  it("has exactly four tools, all read-only, with data-only descriptions", () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual([
      "get_attention_list",
      "get_budget_status",
      "get_number",
      "get_spending_summary",
    ]);
    for (const t of MCP_TOOLS) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
      const d = t.description.toLowerCase();
      // "not financial advice" is the required educational framing; advice
      // *recommendations* ("you should…") are what must never appear.
      expect(d).not.toMatch(/you should|we recommend|i recommend|should buy|should sell|should invest/);
    }
  });

  it("no-demo guard throws on demo provenance and passes on real", () => {
    expect(() =>
      guardNoDemo({ provenance: { budget: "demo" } } as any, "test")
    ).toThrow(/demo provenance/);
    expect(() =>
      guardNoDemo({ provenance: { budget: "real", number: "missing" } } as any, "test")
    ).not.toThrow();
  });
});
