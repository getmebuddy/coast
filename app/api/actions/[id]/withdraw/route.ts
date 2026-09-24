/**
 * POST /api/actions/[id]/withdraw — stop a request before it completes.
 *
 * Invalid transitions (e.g. already completed) map to 409. The
 * 'request_withdrawn' event is appended before the status update.
 */
import {
  appendEvent,
  fail,
  getAuth,
  ok,
} from "@/app/api/_lib/subscription-actions";
import { assertTransition, type ActionState } from "@/lib/subscriptions";

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

  try {
    assertTransition(request.status as ActionState, "withdrawn");
  } catch (e) {
    return fail(
      "invalid_transition",
      e instanceof Error ? e.message : "This request cannot be withdrawn.",
      409
    );
  }

  const eventError = await appendEvent(supabase, {
    request_id: request.id,
    user_id: user.id,
    event_type: "request_withdrawn",
    actor_type: "user",
    payload: {},
  });
  if (eventError) {
    return fail("db-write", "Could not record the withdrawal event.", 500);
  }

  const { data: updated, error: updateError } = await supabase
    .from("action_requests")
    .update({ status: "withdrawn" })
    .eq("id", request.id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (updateError) {
    return fail("db-write", "Could not withdraw the request.", 500);
  }

  return ok({ request: updated ?? request });
}
