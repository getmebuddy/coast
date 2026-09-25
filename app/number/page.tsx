/**
 * The Number — server wrapper.
 *
 * Loads the planner baseline: the signed-in user's saved FIRE settings when
 * present, the Number setup state when they have none, and seeded demo
 * settings for signed-out demo mode. All interactivity lives in
 * WhatIfPlanner (client).
 */
import { createServerSupabase } from "@/lib/supabase/server";
import { demoSurplus, observedMonthlySurplusCents } from "@/lib/whatif";
import { demoTransactions } from "@/lib/demo";
import { demoFire } from "@/lib/demo";
import type { WhatIfInputs } from "@/lib/whatif";
import WhatIfPlanner, { type PlannerInitial, type PlannerMode } from "./WhatIfPlanner";

function demoBaseline(): WhatIfInputs {
  return {
    monthlySpendingCents: Math.round(demoFire.annual_spending_cents / 12),
    portfolioCents: demoFire.portfolio_cents,
    monthlyInvestmentCents: demoFire.monthly_savings_cents,
    annualReturnPct: demoFire.expected_return_pct,
    targetMode: "auto",
    customTargetCents: null,
    investDifference: false,
  };
}

/**
 * Signed-in setup baseline: blank, visibly unsaved. Never prefill demo
 * values for a signed-in user — they read as the user's own data.
 */
function emptyBaseline(): WhatIfInputs {
  return {
    monthlySpendingCents: 0,
    portfolioCents: 0,
    monthlyInvestmentCents: 0,
    annualReturnPct: 7,
    targetMode: "auto",
    customTargetCents: null,
    investDifference: false,
  };
}

interface FireSettingsRow {
  annual_spending_cents: number;
  portfolio_cents: number;
  monthly_savings_cents: number;
  expected_return_pct: number | string;
  target_number_cents: number | null;
  target_mode: string | null;
  settings_version: number | null;
  updated_at: string;
}

function rowToInputs(row: FireSettingsRow): WhatIfInputs {
  return {
    monthlySpendingCents: Math.round(row.annual_spending_cents / 12),
    portfolioCents: row.portfolio_cents,
    monthlyInvestmentCents: row.monthly_savings_cents,
    annualReturnPct: Number(row.expected_return_pct),
    targetMode: row.target_mode === "custom" ? "custom" : "auto",
    customTargetCents: row.target_number_cents,
    investDifference: false,
  };
}

export default async function NumberPage() {
  let initial: PlannerInitial = {
    baseline: demoBaseline(),
    settingsVersion: 0,
    savedAt: null,
    mode: "demo",
    observedSurplusCents: demoSurplus(
      demoTransactions.map((t) => ({
        amount_cents: t.amount_cents,
        kind: t.kind,
        posted_at: t.date,
        pending: t.pending,
      }))
    ),
  };

  try {
    const supabase = createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      const { data: row } = await supabase
        .from("fire_settings")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      // Observed monthly surplus from the user's own ledger (best effort).
      let surplus: number | null = null;
      try {
        const { data: txns } = await supabase
          .from("transactions")
          .select("amount_cents,kind,posted_at,pending")
          .eq("user_id", user.id)
          .limit(2000);
        if (txns && txns.length > 0) {
          surplus = observedMonthlySurplusCents(txns);
        }
      } catch {
        /* surplus stays null — feasibility note simply won't show */
      }

      if (row) {
        const typed = row as FireSettingsRow;
        initial = {
          baseline: rowToInputs(typed),
          settingsVersion: typed.settings_version ?? 1,
          savedAt: typed.updated_at,
          mode: "saved" as PlannerMode,
          observedSurplusCents: surplus,
        };
      } else {
        initial = {
          baseline: emptyBaseline(),
          settingsVersion: 0,
          savedAt: null,
          mode: "setup" as PlannerMode,
          observedSurplusCents: surplus,
        };
      }
    }
  } catch {
    /* fall back to demo baseline — the planner still works */
  }

  return <WhatIfPlanner initial={initial} />;
}
