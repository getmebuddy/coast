/**
 * POST /api/actions/[id]/launch — start a direct route (spec §9, FR-11).
 *
 * Direct routes only. Re-verifies the registry record (active, eligible,
 * destination present) immediately before issuing a signed route token.
 * The client receives the token — never the raw URL. Opening a destination
 * records Action started, never Cancelled.
 */
import {
  appendEvent,
  fail,
  getAuth,
  ok,
  ROUTE_SECRET,
  ROUTE_SIGNING_CONFIGURED,
} from "@/app/api/_lib/subscription-actions";
import { trackActionEvent } from "@/lib/analytics";
import {
  assertTransition,
  routeEligible,
  type ActionState,
} from "@/lib/subscriptions";
import { issueRouteToken } from "@/lib/subscriptions-server";

const TOKEN_TTL_SECONDS = 900;

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);
  if (!ROUTE_SIGNING_CONFIGURED) {
    return fail("route_signing", "route signing not configured", 500);
  }

  const { data: request } = await supabase
    .from("action_requests")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!request) return fail("not_found", "Action request not found.", 404);

  if (request.route_type !== "direct") {
    return fail(
      "not_applicable",
      "Launch is only available for direct routes.",
      400
    );
  }

  try {
    assertTransition(request.status as ActionState, "action_started");
  } catch (e) {
    return fail(
      "invalid_transition",
      e instanceof Error ? e.message : "This request cannot be started.",
      409
    );
  }

  // Re-verify the registry record immediately before launch (spec §9).
  const { data: record } = await supabase
    .from("merchant_registry")
    .select("*")
    .eq("merchant_key", request.merchant_key)
    .maybeSingle();
  if (!record || !record.active) {
    return fail(
      "route_revoked",
      "This route was disabled. No destination was opened.",
      409
    );
  }
  const elig = routeEligible(
    {
      active: record.active,
      confidence: record.confidence,
      source_checked_at: record.source_checked_at ?? "",
      failure_count_7d: record.failure_count_7d ?? 0,
      supported_actions: record.supported_actions ?? [],
    },
    "direct",
    new Date()
  );
  if (!elig.ok) {
    return fail(
      "route_unavailable",
      `This route is not eligible for launch (${elig.reason}).`,
      409
    );
  }
  if (!record.destination_ref) {
    return fail(
      "route_unavailable",
      "This route has no verified destination.",
      409
    );
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const token = issueRouteToken(ROUTE_SECRET, {
    request_id: request.id,
    destination: record.destination_ref,
    registry_version: record.version,
    exp_epoch: nowEpoch + TOKEN_TTL_SECONDS,
  });

  // Event BEFORE the status update (spec §8). No URL in the payload.
  const eventError = await appendEvent(supabase, {
    request_id: request.id,
    user_id: user.id,
    event_type: "route_launched",
    actor_type: "user",
    payload: { registry_version: record.version, route_type: "direct" },
  });
  if (eventError) {
    return fail("db-write", "Could not record the launch event.", 500);
  }

  const { error: updateError } = await supabase
    .from("action_requests")
    .update({
      status: "action_started",
      opened_at: new Date().toISOString(),
    })
    .eq("id", request.id)
    .eq("user_id", user.id);
  if (updateError) {
    return fail("db-write", "Could not start the action.", 500);
  }

  trackActionEvent("action_started", {
    action_type: request.action_type,
    route_type: "direct",
  });
  return ok({
    launch_url: `/api/actions/route?token=${token}`,
    token_expires_in: TOKEN_TTL_SECONDS,
  });
}
