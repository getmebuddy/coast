/**
 * GET /api/subscriptions — list the user's recurring series for the
 * Subscription Action Center.
 *
 * Excludes dismissed series. Sorted by monthly cost desc. Registry display
 * info (display_name, route_type, confidence) is left-joined from
 * merchant_registry in code. Evidence fields per series: representative
 * amounts, cadence, last observed charge date (from the ledger), next charge
 * date, price-change flag, lifecycle state, and any user correction.
 */
import {
  fail,
  getAuth,
  ok,
  toSubscriptionCadence,
} from "@/app/api/_lib/subscription-actions";
import { trackActionEvent } from "@/lib/analytics";
import { monthlyEquivalentFor } from "@/lib/subscriptions";

export async function GET() {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { data: rows, error } = await supabase
    .from("recurring")
    .select(
      "id, merchant_normalized, merchant_key, amount_cents_avg, cadence, " +
        "next_charge_date, last_amount_cents, prev_amount_cents, price_changed, " +
        "dismissed, lifecycle_state, user_correction, billing_channel, " +
        "confidence, next_expected_at"
    )
    .eq("user_id", user.id)
    .neq("dismissed", true);
  if (error) return fail("db-read", "Could not load subscriptions.", 500);

  const list: any[] = rows ?? [];

  // Registry display info, keyed by the series' pinned merchant_key.
  const keys = [
    ...new Set(list.map((r) => r.merchant_key).filter(Boolean)),
  ] as string[];
  const registryByKey = new Map<string, any>();
  if (keys.length > 0) {
    const { data: regs } = await supabase
      .from("merchant_registry")
      .select("merchant_key, display_name, route_type, confidence")
      .in("merchant_key", keys);
    for (const r of (regs ?? []) as any[]) {
      registryByKey.set(r.merchant_key, r);
    }
  }

  // Last observed charge date per merchant, straight from the ledger (FR-01
  // evidence). last_charge_date is not a stored recurring column, so this is
  // the honest source for "when did this last bill you".
  const merchants = [
    ...new Set(list.map((r) => r.merchant_normalized)),
  ] as string[];
  const lastChargeByMerchant = new Map<string, string>();
  if (merchants.length > 0) {
    const { data: txns } = await supabase
      .from("transactions")
      .select("merchant_normalized, posted_at")
      .eq("user_id", user.id)
      .in("merchant_normalized", merchants)
      .lt("amount_cents", 0)
      .eq("pending", false)
      .order("posted_at", { ascending: false })
      .limit(5000);
    for (const t of (txns ?? []) as any[]) {
      if (!lastChargeByMerchant.has(t.merchant_normalized)) {
        lastChargeByMerchant.set(t.merchant_normalized, t.posted_at);
      }
    }
  }

  const items = list
    .map((r) => {
      const reg = r.merchant_key
        ? (registryByKey.get(r.merchant_key) ?? null)
        : null;
      return {
        id: r.id,
        merchant_normalized: r.merchant_normalized,
        merchant_key: r.merchant_key,
        display_name: reg?.display_name ?? null,
        route_type: reg?.route_type ?? null,
        registry_confidence: reg?.confidence ?? null,
        billing_channel: r.billing_channel,
        last_amount_cents: r.last_amount_cents,
        amount_cents_avg: r.amount_cents_avg,
        cadence: r.cadence,
        monthly_cents: monthlyEquivalentFor(
          toSubscriptionCadence(r.cadence),
          r.last_amount_cents ?? 0
        ),
        last_charge_date:
          lastChargeByMerchant.get(r.merchant_normalized) ?? null,
        next_charge_date: r.next_charge_date,
        next_expected_at: r.next_expected_at,
        price_changed: r.price_changed,
        prev_amount_cents: r.prev_amount_cents,
        lifecycle_state: r.lifecycle_state,
        user_correction: r.user_correction,
      };
    })
    .sort((a, b) => b.monthly_cents - a.monthly_cents);

  trackActionEvent("action_center_viewed");
  return ok({ items });
}
