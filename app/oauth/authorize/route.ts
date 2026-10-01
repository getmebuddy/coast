/**
 * GET/POST /oauth/authorize — authorization endpoint with user consent.
 *
 * GET validates the request, requires a signed-in Coast user (routing
 * through /login with ?next= resume when signed out), and renders a consent
 * screen. POST processes the approve/deny decision (CSRF-protected) and
 * issues a single-use authorization code bound to the client, redirect URI,
 * and PKCE challenge.
 */
import { randomBytes } from "node:crypto";
import {
  validateAuthorize,
  issueAuthCode,
  type AuthorizeParams,
} from "@/lib/mcp/oauth";
import { createSupabaseMcpStore } from "@/lib/mcp/store";
import { getViewer } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const CSRF_COOKIE = "mcp_oauth_csrf";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function paramsFrom(url: URL): AuthorizeParams {
  return {
    client_id: url.searchParams.get("client_id"),
    redirect_uri: url.searchParams.get("redirect_uri"),
    response_type: url.searchParams.get("response_type"),
    scope: url.searchParams.get("scope"),
    state: url.searchParams.get("state"),
    code_challenge: url.searchParams.get("code_challenge"),
    code_challenge_method: url.searchParams.get("code_challenge_method"),
  };
}

function redirectWithError(redirectUri: string, error: string, state: string): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (state) u.searchParams.set("state", state);
  return Response.redirect(u.toString(), 302);
}

function consentPage(args: {
  clientName: string;
  csrf: string;
  params: Record<string, string>;
}): string {
  const hidden = Object.entries(args.params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${escapeHtml(args.clientName)} — Coast</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.25rem;color:#111}
.card{border:1px solid #e5e5e5;border-radius:12px;padding:1.5rem}.muted{color:#666;font-size:.9rem}
.row{display:flex;gap:.75rem;margin-top:1.25rem}button{flex:1;padding:.75rem;border-radius:8px;font-size:1rem;cursor:pointer}
.approve{background:#111;color:#fff;border:none}.deny{background:#fff;border:1px solid #ccc}</style></head>
<body><div class="card">
<h2>Connect ${escapeHtml(args.clientName)} to Coast?</h2>
<p><strong>${escapeHtml(args.clientName)}</strong> is requesting <strong>read-only</strong> access to your Coast account:</p>
<ul class="muted">
<li>Your Number and progress toward it</li>
<li>Budget status and category totals</li>
<li>Attention items from your Morning Brief</li>
<li>Spending summaries by category</li>
</ul>
<p class="muted">Coast never shares transaction details or account numbers, and this connection cannot move money or change anything.</p>
<form method="post">
${hidden}
<input type="hidden" name="csrf" value="${escapeHtml(args.csrf)}" />
<div class="row">
<button class="deny" type="submit" name="decision" value="deny">Deny</button>
<button class="approve" type="submit" name="decision" value="approve">Approve</button>
</div></form></div></body></html>`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const store = createSupabaseMcpStore();
  const p = paramsFrom(url);
  const validated = await validateAuthorize(store, p);
  if ("error" in validated) {
    if (validated.fatal) {
      return new Response(`<h1>Authorization error</h1><p>${escapeHtml(validated.error.error_description)}</p>`, {
        status: 400,
        headers: { "Content-Type": "text/html", ...NO_STORE },
      });
    }
    // Non-fatal: redirect_uri is trusted, send the error back to the client.
    return redirectWithError(p.redirect_uri!, validated.error.error, p.state ?? "");
  }

  let viewer: Awaited<ReturnType<typeof getViewer>>;
  try {
    viewer = await getViewer();
  } catch {
    return new Response("Authentication service unavailable. Please try again.", { status: 503, headers: NO_STORE });
  }
  if (!viewer) {
    const next = `/oauth/authorize?${url.searchParams.toString()}`;
    return Response.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
  }

  const csrf = randomBytes(16).toString("base64url");
  const passThrough: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) passThrough[k] = v;
  const html = consentPage({ clientName: validated.client_name, csrf, params: passThrough });
  const secure = url.protocol === "https:";
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": `${CSRF_COOKIE}=${csrf}; Path=/oauth/authorize; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`,
      ...NO_STORE,
    },
  });
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return new Response("Invalid form submission.", { status: 400, headers: NO_STORE });
  const cookie = req.headers.get("cookie") ?? "";
  const csrfCookie = /(?:^|;\s*)mcp_oauth_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  const csrfForm = String(form.get("csrf") ?? "");
  if (!csrfCookie || !csrfForm || csrfCookie !== csrfForm) {
    return new Response("Session expired. Please restart the authorization.", { status: 403, headers: NO_STORE });
  }

  let viewer: Awaited<ReturnType<typeof getViewer>>;
  try {
    viewer = await getViewer();
  } catch {
    return new Response("Authentication service unavailable. Please try again.", { status: 503, headers: NO_STORE });
  }
  if (!viewer) {
    return Response.redirect("/login?next=/oauth/authorize", 302);
  }

  const store = createSupabaseMcpStore();
  const p: AuthorizeParams = {
    client_id: String(form.get("client_id") ?? ""),
    redirect_uri: String(form.get("redirect_uri") ?? ""),
    response_type: String(form.get("response_type") ?? ""),
    scope: String(form.get("scope") ?? ""),
    state: String(form.get("state") ?? ""),
    code_challenge: String(form.get("code_challenge") ?? ""),
    code_challenge_method: String(form.get("code_challenge_method") ?? ""),
  };
  const validated = await validateAuthorize(store, p);
  if ("error" in validated) {
    if (validated.fatal) {
      return new Response("Authorization request is no longer valid.", { status: 400, headers: NO_STORE });
    }
    return redirectWithError(p.redirect_uri!, validated.error.error, p.state ?? "");
  }

  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve") {
    return redirectWithError(validated.redirect_uri, "access_denied", validated.state);
  }

  const code = await issueAuthCode(store, {
    client_id: validated.client_id,
    user_id: viewer.userId,
    redirect_uri: validated.redirect_uri,
    code_challenge: String(form.get("code_challenge") ?? ""),
    scope: validated.scope,
  });
  const u = new URL(validated.redirect_uri);
  u.searchParams.set("code", code);
  if (validated.state) u.searchParams.set("state", validated.state);
  // Burn the CSRF cookie.
  const secure = new URL(req.url).protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: {
      Location: u.toString(),
      "Set-Cookie": `${CSRF_COOKIE}=; Path=/oauth/authorize; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
      ...NO_STORE,
    },
  });
}
