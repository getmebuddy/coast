/**
 * Recurring-charge detector — pure, ledger-driven.
 *
 * Groups posted outflows by normalized merchant, infers cadence from charge
 * intervals, and flags price changes. Works on any transaction list
 * (demo ledger today, Plaid-synced rows after M3).
 *
 * Design notes:
 *  - Cadence regularity is the primary signal; amount stability is secondary.
 *    Variable bills (utilities) are still recurring — they just never trigger
 *    a price-change flag, because their history isn't stable.
 *  - A price change is flagged only when the charges *before* the latest
 *    price were all identical and the new price differs meaningfully.
 *    This keeps one-off variance (Xcel Energy) quiet while catching real
 *    hikes (Netflix $15.49 -> $17.99).
 *  - Needs >= 3 charges: with fewer, weekly vs monthly vs coincidence can't
 *    be told apart. Annual charges with a single sighting in-window
 *    (e.g. Amazon Prime) are a known blind spot — in production Plaid's
 *    /transactions/recurring/get covers those.
 *
 * Money: integer cents (positive). Dates: YYYY-MM-DD.
 */

export type Cadence = "weekly" | "monthly" | "annual";

export interface RecurringInput {
  merchant: string; // normalized merchant name
  amount_cents: number; // signed; negative = money out
  date: string; // YYYY-MM-DD posted date
  kind: string; // "expense" | "fee" | "transfer" | ...
  pending?: boolean;
}

export interface DetectedRecurring {
  merchant: string;
  cadence: Cadence;
  charges_count: number;
  /** Most recent charge — the expected next charge. Positive cents. */
  amount_cents: number;
  /** Mean of observed charges, rounded. Positive cents. */
  amount_cents_avg: number;
  last_charge_date: string;
  next_charge_date: string;
  price_changed: boolean;
  prev_amount_cents: number | null;
  /** One charge normalized to a monthly cost. Positive cents. */
  monthly_cents: number;
}

const MIN_CHARGES = 3;

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000
  );
}

function median(nums: number[]): number {
  const s = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function inferCadence(medianDays: number): Cadence | null {
  if (medianDays >= 6 && medianDays <= 8) return "weekly";
  if (medianDays >= 27 && medianDays <= 33) return "monthly";
  if (medianDays >= 350 && medianDays <= 380) return "annual";
  return null;
}

function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMonthsISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  // Clamp: setUTCMonth overflows into the next month for short months
  // (e.g. Jan 31 + 1mo -> Mar 3); pull back to the last day instead.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export function nextChargeDate(lastChargeDate: string, cadence: Cadence): string {
  if (cadence === "weekly") return addDaysISO(lastChargeDate, 7);
  if (cadence === "monthly") return addMonthsISO(lastChargeDate, 1);
  return addMonthsISO(lastChargeDate, 12);
}

/** Monthly equivalent of one charge at a cadence. Positive cents in/out. */
export function monthlyEquivalent(amountCents: number, cadence: Cadence): number {
  if (cadence === "weekly") return Math.round((amountCents * 52) / 12);
  if (cadence === "annual") return Math.round(amountCents / 12);
  return amountCents;
}

/**
 * Detect recurring charges in a transaction list.
 * Returns one entry per recurring merchant, sorted by monthly cost desc.
 */
export function detectRecurring(
  txns: RecurringInput[],
  opts: { minCharges?: number } = {}
): DetectedRecurring[] {
  const minCharges = opts.minCharges ?? MIN_CHARGES;

  const byMerchant = new Map<string, RecurringInput[]>();
  for (const t of txns) {
    if (t.pending) continue;
    if (t.kind !== "expense" && t.kind !== "fee") continue;
    if (t.amount_cents >= 0) continue; // outflows only
    const list = byMerchant.get(t.merchant) ?? [];
    list.push(t);
    byMerchant.set(t.merchant, list);
  }

  const out: DetectedRecurring[] = [];
  for (const [merchant, charges] of byMerchant) {
    if (charges.length < minCharges) continue;
    const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
    const amounts = sorted.map((t) => Math.abs(t.amount_cents));

    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    }
    const med = median(intervals);
    const cadence = inferCadence(med);
    if (!cadence) continue;

    // Regularity: every interval close to the median. Catches the
    // "two subscriptions then a random purchase" case.
    const tolerance = Math.max(2, med * 0.25);
    if (!intervals.every((iv) => Math.abs(iv - med) <= tolerance)) continue;

    // Price change: trailing run at the latest price vs. a stable earlier price.
    const last = amounts[amounts.length - 1];
    let runStart = amounts.length - 1;
    while (runStart > 0 && amounts[runStart - 1] === last) runStart--;
    const prior = amounts.slice(0, runStart);
    let price_changed = false;
    let prev_amount_cents: number | null = null;
    if (prior.length > 0 && prior.every((a) => a === prior[0]) && prior[0] !== last) {
      const oldPrice = prior[0];
      const delta = Math.abs(last - oldPrice);
      if (delta >= Math.max(50, Math.round(oldPrice * 0.05))) {
        price_changed = true;
        prev_amount_cents = oldPrice;
      }
    }

    const lastChargeDate = sorted[sorted.length - 1].date;
    out.push({
      merchant,
      cadence,
      charges_count: sorted.length,
      amount_cents: last,
      amount_cents_avg: Math.round(
        amounts.reduce((s, a) => s + a, 0) / amounts.length
      ),
      last_charge_date: lastChargeDate,
      next_charge_date: nextChargeDate(lastChargeDate, cadence),
      price_changed,
      prev_amount_cents,
      monthly_cents: monthlyEquivalent(last, cadence),
    });
  }

  return out.sort((a, b) => b.monthly_cents - a.monthly_cents);
}

/** Sum of monthly equivalents across detected charges. */
export function totalMonthlyRecurringCents(detected: DetectedRecurring[]): number {
  return detected.reduce((s, d) => s + d.monthly_cents, 0);
}

export interface RecurringUpsertRow {
  user_id: string;
  merchant_normalized: string;
  amount_cents_avg: number;
  cadence: string;
  next_charge_date: string;
  last_amount_cents: number;
  prev_amount_cents: number | null;
  price_changed: boolean;
  dismissed: boolean;
  updated_at: string;
}

/**
 * Map detector output onto `recurring` table upsert rows.
 * A user's explicit "not a subscription" dismissal is NEVER clobbered:
 * the caller passes the current dismissed flags and they carry through.
 * Pure — no I/O.
 */
export function toRecurringUpsertRows(
  userId: string,
  detected: DetectedRecurring[],
  dismissedByMerchant: Map<string, boolean>,
  nowISO: string
): RecurringUpsertRow[] {
  return detected.map((d) => ({
    user_id: userId,
    merchant_normalized: d.merchant,
    amount_cents_avg: d.amount_cents,
    cadence: d.cadence,
    next_charge_date: d.next_charge_date,
    last_amount_cents: d.amount_cents,
    prev_amount_cents: d.prev_amount_cents,
    price_changed: d.price_changed,
    dismissed: dismissedByMerchant.get(d.merchant) ?? false,
    updated_at: nowISO,
  }));
}
