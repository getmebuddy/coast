/**
 * POST /oauth/token — authorization_code and refresh_token grants.
 * Accepts application/x-www-form-urlencoded (standard) or JSON.
 */
import {
  exchangeCode,
  refreshTokens,
  checkRateLimit,
  MCP_SCOPE,
  type TokenPair,
} from "@/lib/mcp/oauth";
import { createSupabaseMcpStore } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    return out;
  }
  const form = await req.formData().catch(() => null);
  const out: Record<string, string> = {};
  if (form) for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

function tokenResponse(pair: TokenPair) {
  return Response.json(
    {
      access_token: pair.access_token,
      token_type: "Bearer",
      expires_in: pair.expires_in,
      refresh_token: pair.refresh_token,
      scope: pair.scope,
    },
    { headers: NO_STORE }
  );
}

export async function POST(req: Request) {
  if (!checkRateLimit(`mcp:token:${clientIp(req)}`, 30, 60_000)) {
    return Response.json(
      { error: "rate_limited", error_description: "Too many token requests. Try again later." },
      { status: 429, headers: NO_STORE }
    );
  }
  const p = await readParams(req);
  const store = createSupabaseMcpStore();
  if (p.grant_type === "authorization_code") {
    const result = await exchangeCode(store, {
      code: p.code,
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_verifier: p.code_verifier,
    });
    if ("error" in result) {
      const status = result.error.error === "invalid_request" ? 400 : 400;
      return Response.json(result.error, { status, headers: NO_STORE });
    }
    return tokenResponse(result);
  }
  if (p.grant_type === "refresh_token") {
    const result = await refreshTokens(store, { refresh_token: p.refresh_token, client_id: p.client_id });
    if ("error" in result) {
      return Response.json(result.error, { status: 400, headers: NO_STORE });
    }
    return tokenResponse(result);
  }
  return Response.json(
    { error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token are supported." },
    { status: 400, headers: NO_STORE }
  );
}
