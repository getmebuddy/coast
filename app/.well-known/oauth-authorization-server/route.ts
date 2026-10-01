/**
 * RFC 8414 / OAuth 2.1 authorization-server metadata.
 * MCP clients (Claude, ChatGPT) fetch this to discover the OAuth endpoints.
 */
import { MCP_SCOPE } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}
