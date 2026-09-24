/**
 * POST /api/actions/[id]/authorize — capture narrow, action-specific consent
 * for an assisted request (spec FR-07/FR-08).
 *
 * HARD-GATED: assisted_cancellation is false (migration 005 seeds it off
 * pending legal/ops review). While the global kill switch is off this route
 * returns 403 and the consent code path below is unreachable. Direct and
 * guided routes never need authorization → 400.
 *
 * Slice 5 (assisted pilot) flips the feature flag; the consent-shape code
 * below (consents insert + consentBlocksSubmission) is already wired so the
 * flag flip is the only change needed. Kill switch: setting the flag back to
 * false immediately stops new authorizations without a redeploy.
 */
import {
  appendEvent,
  fail,
  getAuth,
  ok,
  readJsonBody,
} from "@/app/api/_lib/subscription-actions";
import { trackActionEvent } from "@/lib/analytics";
import { assertTransition, type ActionState } from "@/lib/subscriptions";

const CONSENT_TTL_MS = 30 * 24 * 3600 * 1000;

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { data: request } = await supabase
    .from("action_requests")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!request) return fail("not_found", "Action request not found.", 404);

  const { data: flag } = await supabase
    .from("feature_flags")
    .select("enabled")
    .eq("key", "assisted_cancellation")
    .maybeSingle();
  if (!(flag as any)?.enabled) {
    return fail(
      "assisted_unavailable",
      "Assisted cancellation is not enabled.",
      403
    );
  }
  if (request.route_type === "direct" || request.route_type === "guide") {
    return fail(
      "not_applicable",
      "Direct and guided routes do not require authorization.",
      400
    );
  }

  // ---- Consent capture (Slice 5). Reachable only when the flag is on. ----
  const { body, error: jsonError } = await readJsonBody(req);
  if (jsonError) return jsonError;
  const approved_fields = Array.isArray(body?.approved_fields)
    ? (body.approved_fields as unknown[]).filter(
        (f): f is string => typeof f === "string"
      )
    : [];
  const terms_version =
    typeof body?.terms_version === "string" ? body.terms_version : "v1";

  try {
    assertTransition(request.status as ActionState, "authorized");
  } catch (e) {
    return fail(
      "invalid_transition",
      e instanceof Error ? e.message : "This request cannot be authorized.",
      409
    );
  }

  const expires_at = new Date(Date.now() + CONSENT_TTL_MS).toISOString();
  const { data: consent, error: consentError } = await supabase
    .from("consents")
    .insert({
      user_id: user.id,
      request_id: request.id,
      merchant_key: request.merchant_key,
      action_type: request.action_type,
      approved_fields,
      terms_version,
      expires_at,
    })
    .select("*")
    .maybeSingle();
  if (consentError || !consent) {
    return fail("db-write", "Could not capture consent.", 500);
  }

  // Event BEFORE the status update (spec §8).
  const eventError = await appendEvent(supabase, {
    request_id: request.id,
    user_id: user.id,
    event_type: "consent_captured",
    actor_type: "user",
    payload: { consent_id: consent.id, terms_version },
  });
  if (eventError) {
    return fail("db-write", "Could not record the consent event.", 500);
  }

  const { data: updated, error: updateError } = await supabase
    .from("action_requests")
    .update({ status: "authorized", consent_id: consent.id })
    .eq("id", request.id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (updateError) {
    return fail("db-write", "Could not authorize the request.", 500);
  }

  trackActionEvent("action_authorized", { consent_version: terms_version });
  return ok({
    request: updated ?? request,
    consent: { id: consent.id, expires_at },
  });
}
