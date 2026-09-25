import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { logPilotEvent } from "@/lib/analytics-server";
import {
  CALCULATION_VERSION,
  diffInputs,
  projectWhatIf,
  resolveSaveInputs,
  resolveTargetCents,
  validateInputs,
  type WhatIfInputs,
} from "@/lib/whatif";

/**
 * GET /api/fire/settings — the authenticated user's saved FIRE baseline.
 * 401 when signed out (callers fall back to demo seeds); 404 body when no
 * saved plan exists yet (callers show the Number setup state).
 */
export async function GET() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("fire_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "db-read" }, { status: 500 });
  return NextResponse.json({ settings: data });
}

interface SaveBody {
  /** draft scenario inputs (linkage NOT yet folded in) */
  inputs: WhatIfInputs;
  /** baseline inputs the scenario was built against */
  baseline: WhatIfInputs;
  /** baseline settings_version the client saw; 0/absent = first save */
  settingsVersion?: number;
  /** client's projected months for the resolved plan — must match server */
  clientMonths: number | null;
  calculationVersion: string;
  /** optional scenario label */
  name?: string;
}

/**
 * PUT /api/fire/settings — Save as plan.
 * Validates ranges, folds invest-the-difference into the saved inputs,
 * recomputes server-side (rejects client/server calculation mismatch),
 * and persists atomically via save_fire_plan with optimistic concurrency.
 */
export async function PUT(req: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }

  const { inputs, baseline, settingsVersion = 0, clientMonths, calculationVersion, name } = body;
  if (!inputs || !baseline) return NextResponse.json({ error: "bad-input" }, { status: 400 });
  if (calculationVersion !== CALCULATION_VERSION) {
    return NextResponse.json({ error: "stale-engine" }, { status: 400 });
  }
  const bad = [...validateInputs(inputs), ...validateInputs({ ...baseline, investDifference: false })];
  if (bad.length > 0) {
    return NextResponse.json({ error: "validation", fields: [...new Set(bad)] }, { status: 400 });
  }

  // Fold linkage into the persisted plan so the saved row is unambiguous.
  const resolved = resolveSaveInputs(baseline, inputs);
  const serverProj = projectWhatIf(resolved, resolved);
  if (serverProj.months !== clientMonths) {
    // Engine drift between client and server — never persist a result we
    // cannot reproduce. Client refreshes and retries.
    return NextResponse.json({ error: "calculation-mismatch" }, { status: 400 });
  }

  const targetCents = resolveTargetCents(resolved);
  const changedFields = diffInputs(baseline, inputs).map((d) => d.key);

  const { data, error } = await supabase.rpc("save_fire_plan", {
    p_annual_spending_cents: resolved.monthlySpendingCents * 12,
    p_portfolio_cents: resolved.portfolioCents,
    p_monthly_savings_cents: resolved.monthlyInvestmentCents,
    p_expected_return_pct: resolved.annualReturnPct,
    p_target_number_cents: resolved.targetMode === "custom" ? targetCents : null,
    p_target_mode: resolved.targetMode,
    p_calculation_version: CALCULATION_VERSION,
    p_expected_version: settingsVersion,
    p_scenario_name: name ?? null,
    p_scenario_inputs: resolved,
    p_scenario_result: {
      reachable: serverProj.reachable,
      months: serverProj.months,
      arrivalMonth: serverProj.arrivalMonth,
      targetCents: serverProj.targetCents,
      calculationVersion: CALCULATION_VERSION,
    },
    p_changed_fields: changedFields,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("fire_plan_conflict")) {
      // Stale baseline — return the latest so the client can offer review.
      const { data: latest } = await supabase
        .from("fire_settings")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      return NextResponse.json({ error: "conflict", latest }, { status: 409 });
    }
    if (msg.includes("fire_plan_invalid")) {
      return NextResponse.json({ error: "validation", detail: msg }, { status: 400 });
    }
    return NextResponse.json({ error: "db-write" }, { status: 500 });
  }

  // Pilot analytics: a named save is a scenario (what_if_saved); an unnamed
  // save is the core Number setup (number_completed). Non-fatal.
  await logPilotEvent(
    user.id,
    name ? "what_if_saved" : "number_completed",
    name ? { scenario: "named" } : { plan_kind: resolved.targetMode }
  );
  return NextResponse.json({ settings: data });
}
