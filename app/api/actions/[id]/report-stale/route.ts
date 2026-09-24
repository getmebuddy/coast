/**
 * POST /api/actions/[id]/report-stale — report that a route no longer matches
 * (spec FR-12).
 *
 * Increments merchant_registry.failure_count_7d and stamps last_failure_at
 * via the service-role client (the registry is read-only for authenticated
 * users). Rate-limited: one report per request per 24h. The
 * suppress_failing_routes job flips the route's kill switch at >= 2 failures.
 */
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  appendEvent,
  fail,
  getAuth,
  ok,
  readJsonBody,
} from "@/app/api/_lib/subscription-actions";

const REPORT_WINDOW_MS = 24 * 3600 * 1000;

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { body, error: jsonError } = await readJsonBody(req);
  if (jsonError) return jsonError;
  const { note } = body ?? {};
  if (note !== undefined && typeof note !== "string") {
    return fail("invalid_note", "note must be a string.", 400);
  }

  const { data: request } = await supabase
    .from("action_requests")
    .select("id, merchant_key")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!request) return fail("not_found", "Action request not found.", 404);
  if (!request.merchant_key) {
    return fail(
      "no_registry_route",
      "This request has no registry route to report.",
      400
    );
  }

  const windowStart = new Date(Date.now() - REPORT_WINDOW_MS).toISOString();
  const { data: recent } = await supabase
    .from("action_events")
    .select("id")
    .eq("request_id", request.id)
    .eq("event_type", "route_reported_stale")
    .gte("occurred_at", windowStart)
    .limit(1)
    .maybeSingle();
  if (recent) {
    return fail(
      "rate_limited",
      "A stale-route report was already filed for this request in the last 24 hours.",
      429
    );
  }

  const db = createServiceSupabase();
  const { data: record } = await db
    .from("merchant_registry")
    .select("failure_count_7d")
    .eq("merchant_key", request.merchant_key)
    .maybeSingle();
  if (!record) return fail("not_found", "Registry record not found.", 404);

  const next = (record.failure_count_7d ?? 0) + 1;
  const { error: updateError } = await db
    .from("merchant_registry")
    .update({
      failure_count_7d: next,
      last_failure_at: new Date().toISOString(),
    })
    .eq("merchant_key", request.merchant_key);
  if (updateError) {
    return fail("db-write", "Could not record the route report.", 500);
  }

  const eventError = await appendEvent(supabase, {
    request_id: request.id,
    user_id: user.id,
    event_type: "route_reported_stale",
    actor_type: "user",
    payload: note ? { note } : {},
  });
  if (eventError) {
    return fail("db-write", "Could not record the report event.", 500);
  }

  return ok({ failure_count_7d: next });
}
