/**
 * GET /api/subscriptions/[id] — series detail: the row, its registry record,
 * open action requests, the latest savings outcome, and cancel eligibility.
 *
 * PATCH /api/subscriptions/[id] — correct the detector (FR-02) or keep the
 * series (FR-03). Corrections never delete ledger rows; they set
 * user_correction and end the series lifecycle. No action_events rows are
 * appended here (no request involved).
 */
import {
  fail,
  getAuth,
  ok,
  OPEN_REQUEST_STATUSES,
  resolveRegistryRoute,
} from "@/app/api/_lib/subscription-actions";
import { STATUS_COPY } from "@/lib/subscriptions";

const VALID_CORRECTIONS = ["not_recurring", "not_subscription", "duplicate"];

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { data: series, error } = await supabase
    .from("recurring")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return fail("db-read", "Could not load the subscription.", 500);
  if (!series) return fail("not_found", "Subscription not found.", 404);

  const resolved = await resolveRegistryRoute(supabase, series);
  const registry = resolved.record;

  const { data: openRequests } = await supabase
    .from("action_requests")
    .select(
      "id, action_type, route_type, status, registry_version, verification_level, opened_at, created_at"
    )
    .eq("user_id", user.id)
    .eq("series_id", series.id)
    .in("status", [...OPEN_REQUEST_STATUSES])
    .order("created_at", { ascending: false });

  const { data: requestIds } = await supabase
    .from("action_requests")
    .select("id")
    .eq("user_id", user.id)
    .eq("series_id", series.id);
  const ids = ((requestIds ?? []) as any[]).map((r) => r.id);
  let latestSavings: any = null;
  if (ids.length > 0) {
    const { data } = await supabase
      .from("savings_outcomes")
      .select("*")
      .in("request_id", ids)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    latestSavings = data ?? null;
  }

  // Cancel eligibility from the registry capability record (spec §4).
  let eligibility: { eligible: boolean; reason?: string; copy?: string };
  if (registry) {
    const supported = (registry.supported_actions ?? []).includes("cancel");
    const e = resolved.eligibility!;
    if (supported && e.ok) {
      eligibility = { eligible: true };
    } else {
      eligibility = {
        eligible: false,
        reason: !supported ? "action_unsupported" : e.reason,
      };
    }
  } else {
    eligibility = {
      eligible: false,
      reason: "unsupported",
      copy: STATUS_COPY.unsupported,
    };
  }

  return ok({
    series,
    registry,
    open_requests: openRequests ?? [],
    latest_savings: latestSavings,
    eligibility,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_json", "Request body must be valid JSON.", 400);
  }
  const { correction, lifecycle } = body ?? {};

  if (
    correction !== undefined &&
    correction !== null &&
    !VALID_CORRECTIONS.includes(correction)
  ) {
    return fail(
      "invalid_correction",
      "correction must be one of not_recurring, not_subscription, duplicate, or null.",
      400
    );
  }
  if (
    lifecycle !== undefined &&
    lifecycle !== "active" &&
    lifecycle !== "kept"
  ) {
    return fail("invalid_lifecycle", "lifecycle must be 'active' or 'kept'.", 400);
  }
  if (correction === undefined && lifecycle === undefined) {
    return fail(
      "no_changes",
      "Provide correction and/or lifecycle to update.",
      400
    );
  }

  const { data: series, error } = await supabase
    .from("recurring")
    .select("id, lifecycle_state")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return fail("db-read", "Could not load the subscription.", 500);
  if (!series) return fail("not_found", "Subscription not found.", 404);

  const patch: Record<string, unknown> = {};
  // FR-02: a correction ends the series lifecycle; ledger rows are untouched.
  if (correction !== undefined) {
    if (correction === null) {
      patch.user_correction = null;
      patch.lifecycle_state = "active";
    } else {
      patch.user_correction = correction;
      patch.lifecycle_state = "ended";
    }
  }
  // FR-03: keep is an intentional decision; only kept series can be reactivated.
  if (lifecycle !== undefined) {
    if (lifecycle === "kept") {
      patch.lifecycle_state = "kept";
    } else {
      if (series.lifecycle_state !== "kept") {
        return fail(
          "invalid_transition",
          "Only a kept subscription can be set back to active.",
          409
        );
      }
      patch.lifecycle_state = "active";
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("recurring")
    .update(patch)
    .eq("id", series.id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (updateError)
    return fail("db-write", "Could not update the subscription.", 500);

  return ok({ series: updated });
}
