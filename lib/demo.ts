/**
 * Demo ledger adapter — the app is 100% usable with seeded demo data
 * before any Plaid keys exist (master prompt: "demo mode first").
 * Types mirror the Supabase schema; the same query helpers work against
 * real rows when auth + Plaid are connected.
 */

import demo from "./data/demo.json";

export interface DemoTransaction {
  id: string;
  date: string; // YYYY-MM-DD
  merchant: string;
  amount_cents: number; // negative = out
  category: string;
  kind: "income" | "expense" | "transfer" | "refund" | "fee";
  account: string;
  pending: boolean;
}

export interface DemoRecurring {
  merchant: string;
  amount_cents_avg: number; // latest charge = expected next bill
  cadence: "weekly" | "monthly" | "annual";
  next_charge_date: string;
  price_changed: boolean;
  prev_amount_cents: number | null;
  category: string;
  charges_count: number;
  monthly_cents: number; // one charge normalized to a monthly cost
}

export interface DemoBudget {
  category: string; // "__total__" = monthly ceiling
  limit_cents: number;
}

export interface FireSettings {
  annual_spending_cents: number;
  portfolio_cents: number;
  monthly_savings_cents: number;
  expected_return_pct: number;
}

const data = demo as unknown as {
  meta: { range: [string, string] };
  accounts: Array<{ id: string; name: string; type: string; balance_cents: number }>;
  transactions: DemoTransaction[];
  recurring: DemoRecurring[];
  monthlyCommittedBillsCents: number;
  budgets: DemoBudget[];
  fire: FireSettings;
};

export const demoAccounts = data.accounts;
export const demoTransactions: DemoTransaction[] = [...data.transactions].sort((a, b) =>
  b.date.localeCompare(a.date)
);
/** Every recurring charge the detector finds — bills, rent, subscriptions. */
export const demoRecurring = data.recurring;
/**
 * The "subscription reveal" subset: recurring charges you could actually
 * cancel. Housing (rent/mortgage) is committed, not a subscription.
 */
export const demoSubscriptions = data.recurring.filter((r) => r.category !== "Housing");
export const demoBudgets = data.budgets;
export const demoFire: FireSettings = data.fire;
/** Monthly cost across subscriptions (the reveal / price-watch number). */
export const demoMonthlyRecurringCents = demoSubscriptions.reduce(
  (s, r) => s + r.monthly_cents,
  0
);
/** Monthly cost across ALL recurring charges incl. rent — the committed-bills number. */
export const demoCommittedBillsCents = data.monthlyCommittedBillsCents;

/** Spending in a month: expenses + fees only. Transfers/refunds/income excluded. */
export function monthSpending(txns: DemoTransaction[], year: number, month: number): number {
  return txns
    .filter((t) => {
      const d = new Date(t.date + "T00:00:00Z");
      return (
        d.getUTCFullYear() === year &&
        d.getUTCMonth() + 1 === month &&
        (t.kind === "expense" || t.kind === "fee") &&
        !t.pending
      );
    })
    .reduce((sum, t) => sum + Math.abs(t.amount_cents), 0);
}

/** Spending by category for a month. */
export function monthSpendingByCategory(
  txns: DemoTransaction[],
  year: number,
  month: number
): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of txns) {
    const d = new Date(t.date + "T00:00:00Z");
    if (
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() + 1 !== month ||
      (t.kind !== "expense" && t.kind !== "fee") ||
      t.pending
    )
      continue;
    m.set(t.category, (m.get(t.category) ?? 0) + Math.abs(t.amount_cents));
  }
  return m;
}

/** Transactions posted on/after a date (for "new activity"). */
export function txnsSince(txns: DemoTransaction[], iso: string): DemoTransaction[] {
  return txns.filter((t) => t.date >= iso);
}

/** Transactions for a single category in a month, biggest charges first. */
export function categoryDrilldown(
  txns: DemoTransaction[],
  year: number,
  month: number,
  category: string | "__total__"
): DemoTransaction[] {
  return txns
    .filter((t) => {
      const d = new Date(t.date + "T00:00:00Z");
      if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month) return false;
      if (t.kind !== "expense" && t.kind !== "fee") return false;
      if (category !== "__total__" && t.category !== category) return false;
      return true;
    })
    .sort((a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents));
}
