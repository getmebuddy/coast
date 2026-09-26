/**
 * Routines — notify-tier money watchdogs. Pure, ledger-driven.
 *
 * Each detector scans the user's transactions and returns findings with
 * evidence. Nothing here moves money, contacts merchants, or acts
 * autonomously: findings are surfaced for the user to resolve, dismiss,
 * or snooze. Server code upserts them idempotently by dedupe_hash.
 *
 * Conventions (repo-wide):
 *  - Money: integer cents, positive. Dates: YYYY-MM-DD.
 *  - Copy is plain English and calm. Confidence is labeled, never implied
 *    ("possible trial", "possible duplicate").
 */

import { detectRecurring, type RecurringInput } from "./recurring";
import { formatUSD } from "./fire";

export type RoutineKey =
  | "refund_watch"
  | "trial_watch"
  | "price_hike"
  | "duplicate_charge"
  | "fee_sweep"
  | "overlap";

export interface RoutineRegistryEntry {
  key: RoutineKey;
  name: string;
  description: string;
}

export const ROUTINE_REGISTRY: RoutineRegistryEntry[] = [
  { key: "refund_watch", name: "Refund watch", description: "Makes sure money you are owed actually arrives." },
  { key: "trial_watch", name: "Trial watch", description: "Spots possible free trials before they start charging." },
  { key: "price_hike", name: "Price-hike watch", description: "Flags when a subscription raises its price." },
  { key: "duplicate_charge", name: "Duplicate-charge check", description: "Catches the same charge appearing twice." },
  { key: "fee_sweep", name: "Fee sweep", description: "Rounds up bank, late, and foreign-transaction fees." },
  { key: "overlap", name: "Overlap check", description: "Finds subscriptions doing the same job." },
];

export interface RoutineTxn {
  id: string;
  merchant: string; // normalized merchant name
  amount_cents: number; // signed; negative = money out
  date: string; // YYYY-MM-DD posted date
  kind: string; // "income" | "expense" | "transfer" | "refund" | "fee"
  pending?: boolean;
}

export interface RoutineEvidenceTxn {
  id: string;
  merchant: string;
  amount_cents: number;
  date: string;
}

export interface RoutineFinding {
  routine_key: RoutineKey;
  kind: string;
  title: string;
  detail: string;
  /** Positive cents of money at stake; 0 for confirmations. Drives ranking. */
  impact_cents: number;
  evidence: {
    transactions: RoutineEvidenceTxn[];
    [key: string]: unknown;
  };
  dedupe_hash: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000
  );
}

function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function postedOutflows(txns: RoutineTxn[]): RoutineTxn[] {
  return txns.filter(
    (t) =>
      !t.pending &&
      (t.kind === "expense" || t.kind === "fee") &&
      t.amount_cents < 0
  );
}

function toEvidence(t: RoutineTxn): RoutineEvidenceTxn {
  return { id: t.id, merchant: t.merchant, amount_cents: t.amount_cents, date: t.date };
}

function toRecurringInput(t: RoutineTxn): RecurringInput {
  return { merchant: t.merchant, amount_cents: t.amount_cents, date: t.date, kind: t.kind, pending: t.pending };
}

// ---------------------------------------------------------------------------
// Price-hike detection (R4.1) — reuses the recurring detector's price_changed
// ---------------------------------------------------------------------------

export function detectPriceHikes(txns: RoutineTxn[]): RoutineFinding[] {
  const detected = detectRecurring(txns.map(toRecurringInput));
  const out: RoutineFinding[] = [];
  for (const d of detected) {
    if (!d.price_changed || d.prev_amount_cents == null) continue;
    const oldC = d.prev_amount_cents;
    const newC = d.amount_cents;
    const annualDelta = (newC - oldC) * 12;
    out.push({
      routine_key: "price_hike",
      kind: "price_hike",
      title: `${d.merchant} raised its price`,
      detail: `${d.merchant} went from ${formatUSD(oldC)} to ${formatUSD(newC)} a month. That is ${formatUSD(annualDelta)} more a year if you keep it.`,
      impact_cents: annualDelta,
      evidence: {
        transactions: [],
        merchant: d.merchant,
        prev_amount_cents: oldC,
        now_amount_cents: newC,
        cadence: d.cadence,
        last_charge_date: d.last_charge_date,
      },
      dedupe_hash: `price_hike:${d.merchant}:${oldC}:${newC}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Duplicate-charge detection (R4.2)
// Same normalized merchant, amounts within 1%, posted within 3 days.
// Legitimate weekly recurring series are excluded.
// ---------------------------------------------------------------------------

const DUPLICATE_AMOUNT_TOLERANCE = 0.01; // 1%
const DUPLICATE_DAY_WINDOW = 3;

export function detectDuplicates(txns: RoutineTxn[]): RoutineFinding[] {
  const weeklyMerchants = new Set(
    detectRecurring(txns.map(toRecurringInput))
      .filter((d) => d.cadence === "weekly")
      .map((d) => d.merchant)
  );

  const byMerchant = new Map<string, RoutineTxn[]>();
  for (const t of postedOutflows(txns)) {
    if (weeklyMerchants.has(t.merchant)) continue;
    const list = byMerchant.get(t.merchant) ?? [];
    list.push(t);
    byMerchant.set(t.merchant, list);
  }

  const out: RoutineFinding[] = [];
  for (const [merchant, charges] of byMerchant) {
    const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const used = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      if (used.has(sorted[i].id)) continue;
      const cluster: RoutineTxn[] = [sorted[i]];
      for (let j = i + 1; j < sorted.length; j++) {
        if (used.has(sorted[j].id)) continue;
        const a = Math.abs(sorted[i].amount_cents);
        const b = Math.abs(sorted[j].amount_cents);
        const amountClose = Math.abs(a - b) <= Math.max(1, Math.round(a * DUPLICATE_AMOUNT_TOLERANCE));
        const dateClose = daysBetween(sorted[i].date, sorted[j].date) <= DUPLICATE_DAY_WINDOW;
        if (amountClose && dateClose) cluster.push(sorted[j]);
      }
      if (cluster.length >= 2) {
        cluster.forEach((t) => used.add(t.id));
        const amount = Math.abs(cluster[0].amount_cents);
        const dates = cluster.map((t) => t.date).sort();
        out.push({
          routine_key: "duplicate_charge",
          kind: "duplicate_charge",
          title: "Possible duplicate charge",
          detail: `${merchant} charged ${formatUSD(amount)} ${cluster.length} times between ${dates[0]} and ${dates[dates.length - 1]}. If you only bought once, the extra ${formatUSD(amount * (cluster.length - 1))} is worth a look.`,
          impact_cents: amount * (cluster.length - 1),
          evidence: { transactions: cluster.map(toEvidence) },
          dedupe_hash: `duplicate:${merchant}:${dates[0]}:${dates[dates.length - 1]}:${amount}`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Monthly fee sweep (R4.3) — bank fees, late fees, foreign-transaction fees
// over the trailing 30 days, as one digest.
// ---------------------------------------------------------------------------

const FEE_KEYWORDS = [
  "late fee",
  "overdraft",
  "insufficient",
  "foreign transaction",
  "currency conversion",
  "fx fee",
  "atm fee",
  "service charge",
  "maintenance fee",
  "paper statement",
  "annual fee",
];

function looksLikeFee(t: RoutineTxn): boolean {
  if (t.kind === "fee") return true;
  const name = t.merchant.toLowerCase();
  return FEE_KEYWORDS.some((k) => name.includes(k));
}

export function detectFeeSweep(txns: RoutineTxn[], nowISO: string): RoutineFinding[] {
  const cutoff = addDaysISO(nowISO, -30);
  const fees = postedOutflows(txns).filter((t) => t.date >= cutoff && looksLikeFee(t));
  if (fees.length === 0) return [];
  const total = fees.reduce((s, t) => s + Math.abs(t.amount_cents), 0);
  const byMerchant = new Map<string, number>();
  for (const t of fees) {
    byMerchant.set(t.merchant, (byMerchant.get(t.merchant) ?? 0) + Math.abs(t.amount_cents));
  }
  const breakdown = [...byMerchant.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, c]) => `${m} ${formatUSD(c)}`)
    .join(", ");
  const month = nowISO.slice(0, 7);
  return [
    {
      routine_key: "fee_sweep",
      kind: "fee_sweep",
      title: "Fees added up this month",
      detail: `${formatUSD(total)} in fees over the last 30 days across ${fees.length} charge${fees.length === 1 ? "" : "s"}: ${breakdown}.`,
      impact_cents: total,
      evidence: {
        transactions: fees.map(toEvidence),
        window_days: 30,
        fee_count: fees.length,
      },
      dedupe_hash: `fee_sweep:${month}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Subscription overlap (R4.4) — two or more active subscriptions in the
// same category, via a small keyword map.
// ---------------------------------------------------------------------------

const CATEGORY_KEYWORDS: Array<[string, string[]]> = [
  ["music", ["spotify", "apple music", "youtube music", "pandora", "tidal", "deezer", "amazon music"]],
  ["video", ["netflix", "hulu", "disney", "hbo", "max", "peacock", "paramount", "apple tv", "youtube tv", "prime video"]],
  ["news", ["new york times", "nytimes", "washington post", "wall street journal", "wsj", "economist", "atlantic"]],
  ["cloud storage", ["icloud", "google one", "dropbox", "onedrive"]],
  ["fitness", ["peloton", "strava", "fitbit", "gym"]],
];

function categoryFor(merchant: string): string | null {
  const name = merchant.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => name.includes(k))) return category;
  }
  return null;
}

export function detectOverlap(txns: RoutineTxn[]): RoutineFinding[] {
  const detected = detectRecurring(txns.map(toRecurringInput));
  const byCategory = new Map<string, typeof detected>();
  for (const d of detected) {
    const category = categoryFor(d.merchant);
    if (!category) continue;
    const list = byCategory.get(category) ?? [];
    list.push(d);
    byCategory.set(category, list);
  }
  const out: RoutineFinding[] = [];
  for (const [category, subs] of byCategory) {
    if (subs.length < 2) continue;
    const names = subs.map((s) => s.merchant).sort();
    const combined = subs.reduce((s, x) => s + x.monthly_cents, 0);
    out.push({
      routine_key: "overlap",
      kind: "overlap",
      title: `Two ${category} subscriptions`,
      detail: `You pay for ${names.join(" and ")} — ${formatUSD(combined)} a month combined for ${category}. Keeping one would save about ${formatUSD(combined - Math.min(...subs.map((s) => s.monthly_cents)))} a month.`,
      impact_cents: combined,
      evidence: {
        transactions: [],
        category,
        merchants: names,
        combined_monthly_cents: combined,
      },
      dedupe_hash: `overlap:${category}:${names.join("+")}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trial heuristic (R3) — conservative. A small first charge followed by a
// larger one 7-45 days later at the same merchant reads as trial -> paid.
// Always labeled "possible trial".
// ---------------------------------------------------------------------------

const TRIAL_MIN_GAP_DAYS = 7;
const TRIAL_MAX_GAP_DAYS = 45;
const TRIAL_MIN_PAID_CENTS = 500; // $5

export function detectPossibleTrials(txns: RoutineTxn[]): RoutineFinding[] {
  const byMerchant = new Map<string, RoutineTxn[]>();
  for (const t of postedOutflows(txns)) {
    const list = byMerchant.get(t.merchant) ?? [];
    list.push(t);
    byMerchant.set(t.merchant, list);
  }
  const out: RoutineFinding[] = [];
  for (const [merchant, charges] of byMerchant) {
    if (charges.length !== 2) continue;
    const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
    const [first, second] = sorted;
    const gap = daysBetween(first.date, second.date);
    const firstAmt = Math.abs(first.amount_cents);
    const secondAmt = Math.abs(second.amount_cents);
    if (
      gap >= TRIAL_MIN_GAP_DAYS &&
      gap <= TRIAL_MAX_GAP_DAYS &&
      secondAmt >= TRIAL_MIN_PAID_CENTS &&
      firstAmt < secondAmt
    ) {
      out.push({
        routine_key: "trial_watch",
        kind: "trial_watch",
        title: `Possible trial: ${merchant}`,
        detail: `${merchant} charged ${formatUSD(firstAmt)} on ${first.date}, then ${formatUSD(secondAmt)} on ${second.date}. If the first was a trial, the paid plan has started at about ${formatUSD(secondAmt)} a month.`,
        impact_cents: secondAmt,
        evidence: { transactions: sorted.map(toEvidence) },
        dedupe_hash: `trial:${merchant}:${first.date}:${second.date}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Refund watch (R2) — match registered expectations against incoming
// credits. Shortfall = expected minus received, beyond a 50c tolerance.
// ---------------------------------------------------------------------------

export interface ExpectedRefund {
  id: string;
  merchant: string;
  amount_cents: number; // positive
  expected_date: string; // YYYY-MM-DD
}

const REFUND_MATCH_DAYS_BEFORE = 14;
const REFUND_MATCH_DAYS_AFTER = 30;
const REFUND_TOLERANCE_CENTS = 50;

function merchantMatches(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return x === y || x.includes(y) || y.includes(x);
}

export interface RefundMatchResult {
  matched: Array<{ expected: ExpectedRefund; txn: RoutineTxn }>;
  shortfalls: RoutineFinding[];
  received: RoutineFinding[]; // unregistered refund confirmations
}

export function matchRefunds(
  expected: ExpectedRefund[],
  txns: RoutineTxn[]
): RefundMatchResult {
  const credits = txns.filter(
    (t) => !t.pending && t.amount_cents > 0 && (t.kind === "refund" || t.kind === "income")
  );
  const usedCreditIds = new Set<string>();
  const matched: RefundMatchResult["matched"] = [];
  const shortfalls: RoutineFinding[] = [];

  for (const exp of expected) {
    const from = addDaysISO(exp.expected_date, -REFUND_MATCH_DAYS_BEFORE);
    const to = addDaysISO(exp.expected_date, REFUND_MATCH_DAYS_AFTER);
    const candidates = credits
      .filter(
        (c) =>
          !usedCreditIds.has(c.id) &&
          c.date >= from &&
          c.date <= to &&
          merchantMatches(c.merchant, exp.merchant) &&
          c.amount_cents >= Math.round(exp.amount_cents / 2)
      )
      .sort((a, b) => b.amount_cents - a.amount_cents);
    const best = candidates[0];
    if (!best) continue;
    usedCreditIds.add(best.id);
    const gap = exp.amount_cents - best.amount_cents;
    if (gap > REFUND_TOLERANCE_CENTS) {
      shortfalls.push({
        routine_key: "refund_watch",
        kind: "refund_shortfall",
        title: `Refund shortfall: ${exp.merchant}`,
        detail: `You expected ${formatUSD(exp.amount_cents)} back from ${exp.merchant}, but ${formatUSD(best.amount_cents)} arrived — ${formatUSD(gap)} is missing.`,
        impact_cents: gap,
        evidence: {
          transactions: [toEvidence(best)],
          expected_refund_id: exp.id,
          expected_cents: exp.amount_cents,
          received_cents: best.amount_cents,
          gap_cents: gap,
        },
        dedupe_hash: `refund_shortfall:${exp.id}`,
      });
    } else {
      matched.push({ expected: exp, txn: best });
    }
  }

  // Confirmations for refunds that arrived with no registered expectation.
  const received: RoutineFinding[] = [];
  for (const c of credits) {
    if (usedCreditIds.has(c.id)) continue;
    if (c.kind !== "refund") continue;
    received.push({
      routine_key: "refund_watch",
      kind: "refund_received",
      title: "Refund received",
      detail: `${c.merchant} returned ${formatUSD(c.amount_cents)} on ${c.date}.`,
      impact_cents: 0,
      evidence: { transactions: [toEvidence(c)] },
      dedupe_hash: `refund_received:${c.id}`,
    });
  }

  return { matched, shortfalls, received };
}
