/**
 * GET /api/actions/route?token=… — verify a route token and redirect.
 *
 * Spec §9 route integrity: the token's request_id is decoded only to look up
 * the request, then the CURRENT registry record supplies the allowlist and
 * the active status is re-verified immediately before launch. Any failure
 * redirects to /subscriptions?route_error=<code> (expired | invalid |
 * revoked). The server never redirects to a non-allowlisted URL.
 */
import { NextResponse } from "next/server";
import {
  decodeRouteTokenPayload,
  getAuth,
  ROUTE_SECRET,
  ROUTE_SIGNING_CONFIGURED,
} from "@/app/api/_lib/subscription-actions";
import { verifyRouteToken } from "@/lib/subscriptions-server";

function errorRedirect(req: Request, code: string) {
  return NextResponse.redirect(
    new URL(`/subscriptions?route_error=${code}`, req.url),
    302
  );
}

export async function GET(req: Request) {
  if (!ROUTE_SIGNING_CONFIGURED) {
    return NextResponse.json(
      { ok: false, error: "route_signing", message: "route signing not configured" },
      { status: 500 }
    );
  }

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return errorRedirect(req, "invalid");

  const payload = decodeRouteTokenPayload(token);
  if (!payload?.request_id) return errorRedirect(req, "invalid");

  const { supabase, user } = await getAuth();
  if (!user) return errorRedirect(req, "invalid");

  const { data: request } = await supabase
    .from("action_requests")
    .select("id, status, merchant_key")
    .eq("id", payload.request_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!request || !request.merchant_key) return errorRedirect(req, "invalid");

  // Re-verify active status immediately before launch (spec §9).
  const { data: record } = await supabase
    .from("merchant_registry")
    .select("destination_ref, active, version")
    .eq("merchant_key", request.merchant_key)
    .maybeSingle();
  if (!record || !record.active || !record.destination_ref) {
    return errorRedirect(req, "revoked");
  }

  try {
    verifyRouteToken(ROUTE_SECRET, token, [record.destination_ref]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const code = msg.includes("expired")
      ? "expired"
      : msg.includes("allowlisted")
        ? "revoked"
        : "invalid";
    return errorRedirect(req, code);
  }

  // Ensure action_started; only transition out of draft. The 'route_launched'
  // event is appended when it is not already on the timeline.
  if (request.status === "draft") {
    const { data: launched } = await supabase
      .from("action_events")
      .select("id")
      .eq("request_id", request.id)
      .eq("event_type", "route_launched")
      .limit(1)
      .maybeSingle();
    if (!launched) {
      await supabase.from("action_events").insert({
        request_id: request.id,
        user_id: user.id,
        event_type: "route_launched",
        actor_type: "user",
        payload: { registry_version: record.version, route_type: "direct" },
      });
    }
    await supabase
      .from("action_requests")
      .update({
        status: "action_started",
        opened_at: new Date().toISOString(),
      })
      .eq("id", request.id)
      .eq("user_id", user.id);
  }

  return NextResponse.redirect(record.destination_ref, 302);
}
