/**
 * POST /api/actions/preview — resolve the route and terms before anything is
 * started (spec FR-05/FR-06).
 *
 * The server selects the route from the capability registry using merchant,
 * billing channel, jurisdiction, and freshness. Unmatched merchants return an
 * honest unsupported state (never a guessed route). The client receives only
 * the destination hostname — the full URL leaves the server inside a signed
 * route token at launch time.
 */
import {
  fail,
  getAuth,
  hostnameOf,
  ok,
  readJsonBody,
  resolveRegistryRoute,
} from "@/app/api/_lib/subscription-actions";
import { trackActionEvent } from "@/lib/analytics";
import { STATUS_COPY } from "@/lib/subscriptions";

const ACTION_TYPES = ["cancel", "pause", "downgrade"];

export async function POST(req: Request) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { body, error: jsonError } = await readJsonBody(req);
  if (jsonError) return jsonError;
  const { series_id, action_type } = body ?? {};
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

  const { data: series } = await supabase
    .from("recurring")
    .select("id, merchant_normalized, merchant_key")
    .eq("id", series_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!series) return fail("not_found", "Subscription not found.", 404);

  const resolved = await resolveRegistryRoute(supabase, series);
  if (!resolved.matched || !resolved.record) {
    return ok({
      eligible: false,
      state: "unsupported",
      copy: STATUS_COPY.unsupported,
    });
  }
  const record = resolved.record;
  const supported = (record.supported_actions ?? []).includes(action_type);

  const preview = {
    merchant_key: record.merchant_key,
    display_name: record.display_name,
    route_type: record.route_type,
    eligible: supported && resolved.eligibility!.ok,
    reason: !supported
      ? "action_unsupported"
      : resolved.eligibility!.ok
        ? undefined
        : resolved.eligibility!.reason,
    steps: record.guide_steps ?? [],
    destination_host: hostnameOf(record.destination_ref),
    requirements: record.requirements ?? null,
    warnings: record.warnings ?? null,
    data_shared: ["your login session at the merchant (you sign in directly)"],
    fee_cents: 0,
    fee_note: "Self-serve guidance is free.",
    source_checked_at: record.source_checked_at,
    confidence: record.confidence,
    registry_version: record.version,
    next_status_copy: STATUS_COPY.action_started,
  };

  trackActionEvent("action_previewed", {
    route_type: record.route_type,
    confidence: record.confidence,
  });
  return ok(preview);
}
