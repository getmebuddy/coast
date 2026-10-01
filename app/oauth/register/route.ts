/**
 * POST /oauth/register — OAuth 2.0 Dynamic Client Registration (RFC 7591).
 * Public clients (PKCE S256 required); https redirect URIs only
 * (http allowed for localhost dev).
 */
import { registerClient, checkRateLimit } from "@/lib/mcp/oauth";
import { createSupabaseMcpStore } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

export async function POST(req: Request) {
  if (!checkRateLimit(`mcp:register:${clientIp(req)}`, 10, 60_000)) {
    return Response.json(
      { error: "rate_limited", error_description: "Too many registration attempts. Try again later." },
      { status: 429, headers: NO_STORE }
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "Request body must be valid JSON." },
      { status: 400, headers: NO_STORE }
    );
  }
  const result = await registerClient(createSupabaseMcpStore(), (body ?? {}) as Record<string, unknown>);
  if ("error" in result) {
    return Response.json(result.error, { status: 400, headers: NO_STORE });
  }
  return Response.json(
    {
      client_id: result.client_id,
      client_name: result.client_name,
      redirect_uris: result.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "coast:read",
    },
    { status: 201, headers: NO_STORE }
  );
}
