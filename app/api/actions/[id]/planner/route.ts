/**
 * POST /api/actions/[id]/planner — build a temporary What-If scenario from
 * verified savings (spec §7).
 *
 * Requires a savings_outcome on the request. The baseline comes from the
 * user's saved plan: fire_settings.monthly_savings_cents is the plan's
 * monthly investing and settings_version is the baseline version (migration
 * 004). With no saved plan, the baseline is $0 with an explicit note.
 *
 * ASSERT: this route NEVER writes plan tables. It only reads fire_settings
 * and savings_outcomes and returns a temporary scenario input. Changing the
 * user's plan still requires the existing "Save as plan" confirmation flow.
 */
import {
  fail,
  getAuth,
  ok,
  savingsBucket,
} from "@/app/api/_lib/subscription-actions";
import { trackActionEvent } from "@/lib/analytics";
import { buildPlannerHandoff } from "@/lib/subscriptions";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { data: request } = await supabase
    .from("action_requests")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!request) return fail("not_found", "Action request not found.", 404);

  const { data: savings } = await supabase
    .from("savings_outcomes")
    .select("monthly_cents, modeled_months, verification, basis")
    .eq("request_id", request.id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!savings) {
    return fail(
      "no_savings",
      "Record an outcome with savings before opening the planner.",
      400
    );
  }

  const { data: settings } = await supabase
    .from("fire_settings")
    .select("monthly_savings_cents, settings_version")
    .eq("user_id", user.id)
    .maybeSingle();

  const baseline = {
    monthly_investment_cents: settings?.monthly_savings_cents ?? 0,
    version: settings ? String(settings.settings_version) : "none",
  };
  const baseline_note = settings
    ? null
    : "No saved plan yet — the scenario is modeled against a $0 monthly-investing baseline.";

  const handoff = buildPlannerHandoff({
    savings: {
      monthly_cents: savings.monthly_cents ?? 0,
      modeled_months: savings.modeled_months ?? null,
      // modeled_months is null for BOTH permanent savings (cancelled,
      // downgraded) and unknown-duration negotiated savings, so permanence
      // comes from the recorded outcome type, never from the null.
      permanent:
        (savings.basis as { outcome?: string } | null)?.outcome ===
          "cancelled" ||
        (savings.basis as { outcome?: string } | null)?.outcome ===
          "downgraded",
    },
    baseline,
    calc_version: "sac-1.0",
  });

  // Read-only by construction: no insert/update/delete touches fire_settings,
  // fire_scenarios, or any other plan table anywhere in this handler.
  trackActionEvent("planner_handoff", {
    savings_bucket: savingsBucket(savings.monthly_cents ?? 0),
  });

  return ok({
    handoff,
    scenario: {
      monthly_investment_cents: handoff.scenario_monthly_investment_cents,
      temp_only: true as const,
    },
    baseline_note,
  });
}
