/**
 * POST /api/actions/[id]/submit — external handoff for an assisted request
 * (spec §9 connector contract).
 *
 * HARD-GATED: assisted_cancellation is false (migration 005 seeds it off
 * pending legal/ops review). While the global kill switch is off this route
 * returns 403 and the submission code path below is unreachable. Direct and
 * guided routes never go through submission → 400.
 *
 * Slice 5 (assisted pilot) flips the feature flag; the submission path below
 * (consent freshness via consentBlocksSubmission + state-machine transition)
 * is already wired so the flag flip is the only change needed. Expired or
 * withdrawn consent is never silently reused (spec FR-09). Kill switch:
 * setting the flag back to false immediately stops new submissions without
 * a redeploy.
 */
import {
  appendEvent,
  fail,
  getAuth,
  ok,
} from "@/app/api/_lib/subscription-actions";
import { trackActionEvent } from "@/lib/analytics";
import {
  assertTransition,
  consentBlocksSubmission,
  type ActionState,
} from "@/lib/subscriptions";

export async function POST(
  _req: Request,
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
      "Direct and guided routes are not submitted externally.",
      400
    );
  }

  // ---- External handoff (Slice 5). Reachable only when the flag is on. ----
  if (!request.consent_id) {
    return fail(
      "consent_required",
      "Capture consent before submitting.",
      409
    );
  }
  const { data: consent } = await supabase
    .from("consents")
    .select("id, expires_at, withdrawn_at")
    .eq("id", request.consent_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!consent) {
    return fail("consent_required", "Consent record not found.", 409);
  }
  const blocked = consentBlocksSubmission(
    {
      expires_at: consent.expires_at,
      withdrawn_at: consent.withdrawn_at,
    },
    new Date()
  );
  if (blocked) {
    return fail("consent_blocked", blocked, 409);
  }

  try {
    assertTransition(request.status as ActionState, "submitted");
  } catch (e) {
    return fail(
      "invalid_transition",
      e instanceof Error ? e.message : "This request cannot be submitted.",
      409
    );
  }

  // Event BEFORE the status update (spec §8).
  const eventError = await appendEvent(supabase, {
    request_id: request.id,
    user_id: user.id,
    event_type: "request_submitted",
    actor_type: "user",
    payload: { consent_id: consent.id },
  });
  if (eventError) {
    return fail("db-write", "Could not record the submission event.", 500);
  }

  const { data: updated, error: updateError } = await supabase
    .from("action_requests")
    .update({
      status: "submitted",
      submitted_at: new Date().toISOString(),
    })
    .eq("id", request.id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (updateError) {
    return fail("db-write", "Could not submit the request.", 500);
  }

  trackActionEvent("action_submitted", { connector_type: "operator" });
  return ok({ request: updated ?? request });
}
