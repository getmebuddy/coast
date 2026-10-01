/**
 * /mcp request handling with injectable dependencies (store + viewer lookup)
 * so tests can run the full endpoint without a database.
 */
import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveAccessToken } from "./oauth";
import { getMcpViewer, type Viewer } from "./tools";
import { createMcpServer } from "./server";
import { createSupabaseMcpStore, type McpStore } from "./store";

export interface McpDeps {
  store: McpStore;
  resolveViewer: (userId: string) => Promise<Viewer | null>;
}

export const prodMcpDeps: McpDeps = {
  store: createSupabaseMcpStore(),
  resolveViewer: getMcpViewer,
};

const NO_STORE = { "Cache-Control": "no-store" };

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, {
    status: 401,
    headers: {
      ...NO_STORE,
      "WWW-Authenticate": 'Bearer realm="coast-mcp", error="invalid_token", error_description="A valid Coast MCP access token is required."',
    },
  });
}

export async function handleMcpRequest(req: Request, deps: McpDeps = prodMcpDeps): Promise<Response> {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  const resolved = match ? await resolveAccessToken(deps.store, match[1]) : null;
  if (!resolved) return unauthorized();

  const viewer = await deps.resolveViewer(resolved.userId);
  if (!viewer) return unauthorized();
  if (!viewer.realDataEnabled) {
    return Response.json(
      { error: "forbidden", message: "Coast data is not enabled for this account." },
      { status: 403, headers: NO_STORE }
    );
  }

  const server = createMcpServer(viewer);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: safe on serverless
  });
  await server.connect(transport);
  // No transport.close(): the response body is a live SSE stream that must
  // stay open until the runtime finishes sending it. Stateless mode keeps
  // no per-request state, so there is nothing to clean up.
  return transport.handleRequest(req);
}
