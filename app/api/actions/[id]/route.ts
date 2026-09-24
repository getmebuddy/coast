/**
 * GET /api/actions/[id] — request detail: the request, its append-only
 * timeline (ordered by occurred_at), the latest savings outcome, and the
 * user-facing status copy for the next step.
 */
import { fail, getAuth, ok } from "@/app/api/_lib/subscription-actions";
import { STATUS_COPY, type ActionState } from "@/lib/subscriptions";

export async function GET(
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

  const { data: events } = await supabase
    .from("action_events")
    .select("*")
    .eq("request_id", request.id)
    .eq("user_id", user.id)
    .order("occurred_at", { ascending: true });

  const { data: latestSavings } = await supabase
    .from("savings_outcomes")
    .select("*")
    .eq("request_id", request.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return ok({
    request,
    events: events ?? [],
    latest_savings: latestSavings ?? null,
    next_step_copy: STATUS_COPY[request.status as ActionState] ?? null,
  });
}
