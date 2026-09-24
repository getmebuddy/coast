/**
 * POST /api/actions — create an idempotent action-request draft (spec FR-10).
 *
 * Re-runs the server-side preview logic to resolve route_type and
 * registry_version, enforces one open same-type request per series, and uses
 * the create_action_request RPC so a duplicate idempotency key returns the
 * original request instead of failing. A 'draft_created' event is appended
 * before the request moves from identified to draft.
 */
import {
  appendEvent,
  fail,
  getAuth,
  ok,
  OPEN_REQUEST_STATUSES,
  readJsonBody,
  resolveRegistryRoute,
} from "@/app/api/_lib/subscription-actions";
import { STATUS_COPY } from "@/lib/subscriptions";
import { idempotencyKey } from "@/lib/subscriptions-server";

const ACTION_TYPES = ["cancel", "pause", "downgrade"];

export async function POST(req: Request) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { body, error: jsonError } = await readJsonBody(req);
  if (jsonError) return jsonError;
  const { series_id, action_type, idempotency_key } = body ?? {};
  if (!series_id || typeof series_id !== "string") {
    return fail("invalid_series_id", "series_id is required.", 400);
  }
  if (!ACTION_TYPES.includes(action_type)) {
    return fail(
      "invalid_action_type",
      "action_type must be cancel, pause, or downgrade.",
      400
    );
  }
  if (
    idempotency_key !== undefined &&
    (typeof idempotency_key !== "string" ||
      idempotency_key.length === 0 ||
      idempotency_key.length > 128)
  ) {
    return fail(
      "invalid_idempotency_key",
      "idempotency_key must be a non-empty string of at most 128 characters.",
      400
    );
  }

  const { data: series } = await supabase
    .from("recurring")
    .select("id, merchant_normalized, merchant_key")
    .eq("id", series_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!series) return fail("not_found", "Subscription not found.", 404);

  // Server-side route resolution — identical logic to /actions/preview.
  const resolved = await resolveRegistryRoute(supabase, series);
  if (!resolved.matched || !resolved.record) {
    return fail("unsupported", STATUS_COPY.unsupported, 400);
  }
  const record = resolved.record;
  if (!(record.supported_actions ?? []).includes(action_type)) {
    return fail(
      "action_unsupported",
      `This merchant does not support ${action_type} through Coast.`,
      400
    );
  }

  // Assisted is behind the global kill switch (spec §10, §16).
  if (record.route_type === "assisted") {
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
  }

  // One open same-type request per series (FR-10): return the existing one.
  const { data: open } = await supabase
    .from("action_requests")
    .select(
      "id, series_id, merchant_key, action_type, route_type, status, " +
        "registry_version, idempotency_key, verification_level, created_at, opened_at"
    )
    .eq("user_id", user.id)
    .eq("series_id", series.id)
    .eq("action_type", action_type)
    .in("status", [...OPEN_REQUEST_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open) return ok({ request: open, deduped: true });

  const key =
    idempotency_key ??
    idempotencyKey({ userId: user.id, seriesId: series.id, actionType: action_type });

  // Exact-key replay: return the original request and timeline (FR-10).
  const { data: existing } = await supabase
    .from("action_requests")
    .select("*")
    .eq("user_id", user.id)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (existing) return ok({ request: existing, deduped: true });

  const { data: created, error: rpcError } = await supabase.rpc(
    "create_action_request",
    {
      p_user_id: user.id,
      p_series_id: series.id,
      p_merchant_key: record.merchant_key,
      p_action_type: action_type,
      p_route_type: record.route_type,
      p_idempotency_key: key,
      p_registry_version: record.version,
      p_pricing_version: null,
    }
  );
  if (rpcError || !created) {
    return fail("db-write", "Could not create the action request.", 500);
  }

  // Event BEFORE the status update (spec §8).
  const eventError = await appendEvent(supabase, {
    request_id: created.id,
    user_id: user.id,
    event_type: "draft_created",
    actor_type: "user",
    payload: { action_type, route_type: record.route_type },
  });
  if (eventError) {
    return fail("db-write", "Could not record the draft event.", 500);
  }

  const { data: updated, error: updateError } = await supabase
    .from("action_requests")
    .update({ status: "draft" })
    .eq("id", created.id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (updateError) {
    return fail("db-write", "Could not move the request to draft.", 500);
  }

  return ok({ request: updated ?? created, deduped: false }, 201);
}
