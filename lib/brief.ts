/**
 * Morning brief computation — pure, ledger-driven.
 * Readable in ~30 seconds, calm plain-English tone.
 */

import {
  demoFire,
  demoMonthlyRecurringCents,
  demoRecurring,
  demoSubscriptions,
  demoTransactions,
  monthSpending,
  txnsSince,
  type DemoRecurring,
  type DemoTransaction,
} from "./demo";
import { progressPct, projectedFire, targetNumberCents, formatUSD, monthYear } from "./fire";

export interface BriefActivity {
  id: string;
  merchant: string;
  amountCents: number;
  kind: DemoTransaction["kind"];
  pending: boolean;
}

export interface BriefBill {
  merchant: string;
  amountCents: number;
  dueDate: string;
  priceChanged: boolean;
  prevAmountCents: number | null;
}

export interface Brief {
  asOf: string; // YYYY-MM-DD
  greeting: string;
  newActivity: BriefActivity[];
  newActivityTotalCents: number;
  pendingCount: number;
  billsDue: BriefBill[];
  billsDueTotalCents: number;
  budgetMonth: string;
  budgetSpentCents: number;
  budgetLimitCents: number;
  budgetExpectedCents: number; // pro-rata expected by day-of-month
  priceChanges: BriefBill[];
  monthlyRecurringCents: number;
  fireProgressPct: number;
  fireTargetCents: number;
  fireNudge: string;
  fireArrival: string;
  quiet: boolean;
}

const TOTAL_BUDGET_CENTS = 1_000_000; // $10,000 September ceiling

function todayISO(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function yesterdayISO(now: Date): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildBrief(now: Date = new Date()): Brief {
  const asOf = todayISO(now);
  const since = yesterdayISO(now);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  // New activity: posted since yesterday (excluding transfers), pending flagged
  const fresh = txnsSince(demoTransactions, since).filter((t) => t.kind !== "transfer");
  const newActivity: BriefActivity[] = fresh.slice(0, 8).map((t) => ({
    id: t.id,
    merchant: t.merchant,
    amountCents: t.amount_cents,
    kind: t.kind,
    pending: t.pending,
  }));
  const newActivityTotalCents = fresh
    .filter((t) => t.amount_cents < 0)
    .reduce((s, t) => s + Math.abs(t.amount_cents), 0);
  const pendingCount = fresh.filter((t) => t.pending).length;

  // Bills due in the next 7 days
  const horizon = addDaysISO(asOf, 7);
  const billsDue: BriefBill[] = demoRecurring
    .filter((r) => r.next_charge_date >= asOf && r.next_charge_date <= horizon)
    .map((r) => ({
      merchant: r.merchant,
      amountCents: r.amount_cents_avg,
      dueDate: r.next_charge_date,
      priceChanged: r.price_changed,
      prevAmountCents: r.prev_amount_cents,
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const billsDueTotalCents = billsDue.reduce((s, b) => s + b.amountCents, 0);

  // September budget pace
  const budgetSpentCents = monthSpending(demoTransactions, y, m);
  const budgetExpectedCents = Math.round((TOTAL_BUDGET_CENTS * dayOfMonth) / daysInMonth);

  // Subscription watch: price changes + total (cancellable subscriptions only —
  // rent is recurring but not a subscription, so it lives in bills-due instead)
  const priceChanges: BriefBill[] = demoSubscriptions
    .filter((r: DemoRecurring) => r.price_changed)
    .map((r) => ({
      merchant: r.merchant,
      amountCents: r.amount_cents_avg,
      dueDate: r.next_charge_date,
      priceChanged: true,
      prevAmountCents: r.prev_amount_cents,
    }));

  // FIRE nudge
  const target = targetNumberCents(demoFire.annual_spending_cents);
  const pct = progressPct(demoFire.portfolio_cents, target);
  const proj = projectedFire({
    portfolioCents: demoFire.portfolio_cents,
    monthlySavingsCents: demoFire.monthly_savings_cents,
    annualReturnPct: demoFire.expected_return_pct,
    targetCents: target,
    startISO: asOf,
  });
  const fireArrival = monthYear(proj.dateISO);
  const fireNudge =
    proj.reachable && proj.months > 0
      ? `You're ${pct.toFixed(1)}% of the way to ${formatUSD(target)}. On track for ${fireArrival}.`
      : !proj.reachable
        ? "Your plan isn't on track yet — even a small monthly increase moves the date."
        : "You've hit your number. Work is officially optional.";

  const hour = now.getUTCHours(); // UTC is fine for a greeting in demo
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const quiet = newActivity.length === 0 && billsDue.length === 0 && priceChanges.length === 0;

  return {
    asOf,
    greeting,
    newActivity,
    newActivityTotalCents,
    pendingCount,
    billsDue,
    billsDueTotalCents,
    budgetMonth: `${y}-${String(m).padStart(2, "0")}`,
    budgetSpentCents,
    budgetLimitCents: TOTAL_BUDGET_CENTS,
    budgetExpectedCents,
    priceChanges,
    monthlyRecurringCents: demoMonthlyRecurringCents,
    fireProgressPct: pct,
    fireTargetCents: target,
    fireNudge,
    fireArrival,
    quiet,
  };
}
