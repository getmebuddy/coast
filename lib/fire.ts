/**
 * Coast FIRE engine — pure functions, unit-tested.
 * Money is ALWAYS integer cents. No floats cross a function boundary.
 * These functions are the product. Test them like it.
 */

export interface ProjectedFireArgs {
  /** current invested portfolio, integer cents, >= 0 */
  portfolioCents: number;
  /** added at the END of each month, integer cents, can be <= 0 */
  monthlySavingsCents: number;
  /** expected nominal annual return, e.g. 7 for 7% */
  annualReturnPct: number;
  /** the number, integer cents, > 0 */
  targetCents: number;
  /** start date YYYY-MM-DD (defaults to today) */
  startISO?: string;
}

export interface ProjectedFireResult {
  /** false when the target can never be hit (no savings and no growth) */
  reachable: boolean;
  /** months until the number; Infinity when unreachable */
  months: number;
  /** projected arrival date YYYY-MM-DD, null when unreachable */
  dateISO: string | null;
  finalPortfolioCents: number;
}

export interface SafeToSpendArgs {
  cycleIncomeCents: number;
  committedBillsCents: number;
  budgetedSpendCents: number;
  daysLeft: number;
}

/**
 * 4% rule: your number is 25x annual spending.
 * @param annualSpendingCents non-negative integer cents
 */
export function targetNumberCents(annualSpendingCents: number): number {
  if (!Number.isInteger(annualSpendingCents) || annualSpendingCents < 0) {
    throw new Error("annualSpendingCents must be a non-negative integer");
  }
  return annualSpendingCents * 25;
}

/**
 * Monthly-compounding projection: how long until the portfolio hits the target?
 * months is capped at 1200 (100 years) — beyond that we call it unreachable-in-practice.
 */
export function projectedFire(args: ProjectedFireArgs): ProjectedFireResult {
  const { portfolioCents, monthlySavingsCents, annualReturnPct, targetCents, startISO } = args;

  for (const [k, v] of Object.entries({ portfolioCents, monthlySavingsCents, targetCents })) {
    if (!Number.isInteger(v)) throw new Error(`${k} must be integer cents`);
  }
  if (typeof annualReturnPct !== "number" || Number.isNaN(annualReturnPct)) {
    throw new Error("annualReturnPct must be a number");
  }
  if (portfolioCents < 0) throw new Error("portfolioCents must be >= 0");
  if (targetCents <= 0) throw new Error("targetCents must be > 0");

  const start = startISO ? new Date(startISO + "T00:00:00Z") : new Date();
  if (Number.isNaN(start.getTime())) throw new Error("startISO must be YYYY-MM-DD");

  const iso = (d: Date) => d.toISOString().slice(0, 10);

  if (portfolioCents >= targetCents) {
    return { reachable: true, months: 0, dateISO: iso(start), finalPortfolioCents: portfolioCents };
  }
  if (monthlySavingsCents <= 0 && annualReturnPct <= 0) {
    return { reachable: false, months: Infinity, dateISO: null, finalPortfolioCents: portfolioCents };
  }

  const monthlyRate = annualReturnPct / 100 / 12;
  let p = portfolioCents;
  let months = 0;
  const MAX_MONTHS = 1200;
  while (p < targetCents && months < MAX_MONTHS) {
    p = Math.round(p * (1 + monthlyRate) + monthlySavingsCents);
    months += 1;
  }
  if (months >= MAX_MONTHS) {
    return { reachable: false, months: Infinity, dateISO: null, finalPortfolioCents: p };
  }
  const d = new Date(start);
  d.setUTCMonth(d.getUTCMonth() + months);
  return { reachable: true, months, dateISO: iso(d), finalPortfolioCents: p };
}

/**
 * Safe-to-spend: what can be spent per day for the rest of the cycle
 * without breaking the budget or missing committed bills?
 * @returns integer cents per day (floored at 0)
 */
export function safeToSpendCents(args: SafeToSpendArgs): number {
  const { cycleIncomeCents, committedBillsCents, budgetedSpendCents, daysLeft } = args;
  for (const [k, v] of Object.entries({ cycleIncomeCents, committedBillsCents, budgetedSpendCents })) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer`);
  }
  if (!Number.isInteger(daysLeft) || daysLeft < 1) throw new Error("daysLeft must be an integer >= 1");
  const remaining = cycleIncomeCents - committedBillsCents - budgetedSpendCents;
  return Math.max(0, Math.floor(remaining / daysLeft));
}

/** Format integer cents as USD, e.g. 314000 -> "$3,140.00". Display-only. */
export function formatUSD(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error("formatUSD needs integer cents");
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Compact: 3_000_000_00 -> "$3.0M" */
export function formatUSDCompact(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error("formatUSDCompact needs integer cents");
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`;
  return formatUSD(cents);
}

/** Percent of the way to the number, 0–100. */
export function progressPct(portfolioCents: number, targetCents: number): number {
  if (targetCents <= 0) return 0;
  return Math.min(100, Math.max(0, (portfolioCents / targetCents) * 100));
}

/** Human month-year for a projected date, e.g. "2039-06-01" -> "June 2039". */
export function monthYear(dateISO: string | null): string {
  if (!dateISO) return "not on track";
  const [y, m] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
