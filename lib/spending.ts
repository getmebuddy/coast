/**
 * Spending explorer — pure, ledger-driven aggregation.
 *
 * Powers /spending: week/month/quarter/year buckets of income vs. spend,
 * per-category breakdowns with drill-down transactions, net income for the
 * selected period, and the "finish-line pace" marker derived from the user's
 * FIRE settings (annual_spending_cents / 12).
 *
 * Conventions (repo-wide):
 *  - Money: integer cents. Dates: YYYY-MM-DD, compared as UTC.
 *  - Spending = expense/fee kinds, posted only; transfers, refunds, income
 *    never count as spending. Income = income kind, posted, positive.
 */

export type SpendingRange = "week" | "month" | "quarter" | "year";

export const SPENDING_RANGES: SpendingRange[] = ["week", "month", "quarter", "year"];

export interface SpendTxn {
  id: string;
  date: string; // YYYY-MM-DD posted date
  merchant: string;
  /** Plaid logo_url; null/undefined → letter avatar. */
  logoUrl?: string | null;
  amount_cents: number; // signed; negative = money out
  kind: string; // "income" | "expense" | "transfer" | "refund" | "fee"
  pending?: boolean;
  category?: string;
}

export interface BucketCategoryTotal {
  category: string;
  spendCents: number;
  txnCount: number;
}

export interface SpendingBucket {
  key: string; // e.g. "2026-W39", "2026-09", "2026-Q3", "2026"
  label: string; // e.g. "Sep 21", "Sep", "Q3 ’26", "2026"
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
  incomeCents: number;
  spendCents: number;
  /** Per-category totals for this bucket (no top transactions — see buildCategoriesForWindow). */
  categoryTotals: BucketCategoryTotal[];
}

export interface SpendingCategoryRow {
  category: string;
  spendCents: number;
  txnCount: number;
  top: Array<{ id: string; merchant: string; logoUrl?: string | null; date: string; amountCents: number }>;
}

export interface SpendingPeriodData {
  range: SpendingRange;
  buckets: SpendingBucket[];
  /** Income minus spending for the latest (current) bucket's full period. */
  netIncomeCents: number;
  totalSpendCents: number;
  totalIncomeCents: number;
  /** Category breakdown for the latest bucket's full period. */
  categories: SpendingCategoryRow[];
  periodLabel: string;
  /** Finish-line pace scaled to one bucket of this range; null when unknown. */
  finishLinePerBucketCents: number | null;
}

export interface SpendingData {
  ranges: Record<SpendingRange, SpendingPeriodData>;
  /** Monthly spend level consistent with the user's FIRE settings; null when unset. */
  finishLineMonthlyCents: number | null;
}

const DAY_MS = 86_400_000;

function parseDay(iso: string): Date {
  return new Date(iso + "T00:00:00Z");
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = parseDay(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

function monthLabel(iso: string): string {
  return parseDay(iso).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

function isSpendingKind(kind: string): boolean {
  return kind === "expense" || kind === "fee";
}

function isPosted(t: SpendTxn): boolean {
  return !t.pending;
}

interface BucketSpec {
  key: string;
  label: string;
  start: string;
  end: string;
}

function weekSpecs(today: string): BucketSpec[] {
  const d = parseDay(today);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = (dow + 6) % 7;
  const thisMonday = addDays(today, -mondayOffset);
  const out: BucketSpec[] = [];
  for (let i = 7; i >= 0; i--) {
    const start = addDays(thisMonday, -7 * i);
    const end = i === 0 ? today : addDays(start, 6);
    const weekNo = Math.ceil(parseDay(start).getUTCDate() / 7);
    out.push({
      key: `W${start}`,
      label: `${monthLabel(start)} ${parseDay(start).getUTCDate()}`,
      start,
      end,
    });
    void weekNo;
  }
  return out;
}

function monthSpecs(today: string): BucketSpec[] {
  const base = parseDay(today);
  const out: BucketSpec[] = [];
  for (let i = 5; i >= 0; i--) {
    const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i + 1, 0));
    const start = isoDay(first);
    const end = i === 0 ? today : isoDay(last);
    out.push({ key: start.slice(0, 7), label: monthLabel(start), start, end });
  }
  return out;
}

function quarterSpecs(today: string): BucketSpec[] {
  const base = parseDay(today);
  const out: BucketSpec[] = [];
  const curQ = Math.floor(base.getUTCMonth() / 3);
  for (let i = 3; i >= 0; i--) {
    const totalQ = base.getUTCFullYear() * 4 + curQ - i;
    const y = Math.floor(totalQ / 4);
    const q = totalQ % 4;
    const first = new Date(Date.UTC(y, q * 3, 1));
    const last = new Date(Date.UTC(y, q * 3 + 3, 0));
    const start = isoDay(first);
    const end = i === 0 ? today : isoDay(last);
    out.push({
      key: `${y}-Q${q + 1}`,
      label: `Q${q + 1} ’${String(y).slice(2)}`,
      start,
      end,
    });
  }
  return out;
}

function yearSpecs(today: string): BucketSpec[] {
  const y = parseDay(today).getUTCFullYear();
  const out: BucketSpec[] = [];
  for (let i = 4; i >= 0; i--) {
    const yy = y - i;
    out.push({
      key: String(yy),
      label: String(yy),
      start: `${yy}-01-01`,
      end: i === 0 ? today : `${yy}-12-31`,
    });
  }
  return out;
}

function specsFor(range: SpendingRange, today: string): BucketSpec[] {
  switch (range) {
    case "week":
      return weekSpecs(today);
    case "month":
      return monthSpecs(today);
    case "quarter":
      return quarterSpecs(today);
    case "year":
      return yearSpecs(today);
  }
}

const UNCATEGORIZED = "Uncategorized";

/**
 * Category breakdown for an arbitrary [start, end] window — the same shape
 * the explorer shows for the current period. Top transactions capped at 6,
 * biggest first. Pure.
 */
export function buildCategoriesForWindow(
  txns: SpendTxn[],
  start: string,
  end: string
): SpendingCategoryRow[] {
  const byCat = new Map<string, { spent: number; count: number; rows: SpendTxn[] }>();
  for (const t of txns) {
    if (!isPosted(t) || !isSpendingKind(t.kind)) continue;
    if (t.date < start || t.date > end) continue;
    const cat = (t.category ?? "").trim() || UNCATEGORIZED;
    const cur = byCat.get(cat) ?? { spent: 0, count: 0, rows: [] };
    cur.spent += Math.abs(t.amount_cents);
    cur.count += 1;
    cur.rows.push(t);
    byCat.set(cat, cur);
  }
  return [...byCat.entries()]
    .map(([category, v]) => ({
      category,
      spendCents: v.spent,
      txnCount: v.count,
      top: v.rows
        .sort((a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents))
        .slice(0, 6)
        .map((t) => ({
          id: t.id,
          merchant: t.merchant,
          logoUrl: t.logoUrl ?? null,
          date: t.date,
          amountCents: t.amount_cents,
        })),
    }))
    .sort((a, b) => b.spendCents - a.spendCents);
}

/** Totals-only variant for buckets (no top transactions — keeps payloads small). */
function buildCategoryTotalsForWindow(
  txns: SpendTxn[],
  start: string,
  end: string
): BucketCategoryTotal[] {
  return buildCategoriesForWindow(txns, start, end).map((c) => ({
    category: c.category,
    spendCents: c.spendCents,
    txnCount: c.txnCount,
  }));
}

/**
 * Find a bucket by key across all ranges ("2026-09", "2026-Q3", "2026",
 * "W2026-09-01"). Returns the range and bucket, or null. Pure.
 */
export function findBucket(
  data: SpendingData,
  key: string
): { range: SpendingRange; bucket: SpendingBucket } | null {
  if (!/^[A-Za-z0-9-]+$/.test(key) || key.length > 24) return null;
  for (const range of SPENDING_RANGES) {
    const bucket = data.ranges[range].buckets.find((b) => b.key === key);
    if (bucket) return { range, bucket };
  }
  return null;
}

/**
 * "You spent 37% more than you earned." / "You kept 22% of what you earned."
 * Null when there is no income to compare against (or nothing moved at all).
 * Pure.
 */
export function netIncomeLine(incomeCents: number, spendCents: number): string | null {
  if (incomeCents <= 0 || (incomeCents === 0 && spendCents === 0)) return null;
  const net = incomeCents - spendCents;
  if (net < 0) {
    const pct = Math.round((spendCents / incomeCents) * 100 - 100);
    return `You spent ${pct}% more than you earned.`;
  }
  const pct = Math.round((net / incomeCents) * 100);
  return `You kept ${pct}% of what you earned.`;
}

/**
 * "Your finish-line pace is $10,000/mo — you spent $6,040, $3,960 under."
 * Pure.
 */
export function finishLineLine(spendCents: number, paceCents: number): string {
  const delta = spendCents - paceCents;
  const pace = `$${Math.round(paceCents / 100).toLocaleString("en-US")}/mo`;
  const spent = `$${Math.round(spendCents / 100).toLocaleString("en-US")}`;
  if (delta === 0) return `Your finish-line pace is ${pace} — you spent ${spent}, right on pace.`;
  const over = `$${Math.round(Math.abs(delta) / 100).toLocaleString("en-US")} ${delta > 0 ? "over" : "under"}`;
  return `Your finish-line pace is ${pace} — you spent ${spent}, ${over}.`;
}

export interface DonutSegment {
  category: string;
  spendCents: number;
  /** Share of total spend, 0–100. */
  pct: number;
  /** 1-based index into the --chart-N palette; 0 = "Other". */
  colorIndex: number;
}

/**
 * Donut data: the top `limit` categories plus an "Other" rollup.
 * Percentages are of totalSpendCents and sum to ~100. Pure.
 */
export function buildDonutData(
  categories: Pick<SpendingCategoryRow, "category" | "spendCents">[],
  totalSpendCents: number,
  limit = 8
): DonutSegment[] {
  if (totalSpendCents <= 0 || categories.length === 0) return [];
  const top = categories.slice(0, limit);
  const rest = categories.slice(limit);
  const restTotal = rest.reduce((s, c) => s + c.spendCents, 0);
  const segs: DonutSegment[] = top.map((c, i) => ({
    category: c.category,
    spendCents: c.spendCents,
    pct: (c.spendCents / totalSpendCents) * 100,
    colorIndex: i + 1,
  }));
  if (restTotal > 0) {
    segs.push({
      category: "Other",
      spendCents: restTotal,
      pct: (restTotal / totalSpendCents) * 100,
      colorIndex: 0,
    });
  }
  return segs;
}

export interface MonthSummary {
  monthKey: string; // YYYY-MM
  monthLabel: string; // "September"
  incomeCents: number;
  spendCents: number;
  netCents: number;
  /** Posted income+spending transactions in the month. */
  txnCount: number;
  categories: SpendingCategoryRow[];
  biggestTxn: { merchant: string; date: string; amountCents: number } | null;
}

/**
 * Everything the monthly spending report needs, for one YYYY-MM.
 * Pure — the caller resolves categories (effectiveCategory) beforehand.
 */
export function summarizeMonth(txns: SpendTxn[], monthKey: string): MonthSummary {
  const start = `${monthKey}-01`;
  const [y, m] = monthKey.split("-").map(Number);
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
  let incomeCents = 0;
  let spendCents = 0;
  let txnCount = 0;
  let biggest: SpendTxn | null = null;
  for (const t of txns) {
    if (!isPosted(t)) continue;
    if (t.date < start || t.date >= next) continue;
    if (t.kind === "income" && t.amount_cents > 0) {
      incomeCents += t.amount_cents;
      txnCount++;
    } else if (isSpendingKind(t.kind)) {
      spendCents += Math.abs(t.amount_cents);
      txnCount++;
      if (!biggest || Math.abs(t.amount_cents) > Math.abs(biggest.amount_cents)) biggest = t;
    }
  }
  const monthLabel = new Date(`${start}T12:00:00Z`).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return {
    monthKey,
    monthLabel,
    incomeCents,
    spendCents,
    netCents: incomeCents - spendCents,
    txnCount,
    categories: buildCategoriesForWindow(txns, start, addDays(next, -1)),
    biggestTxn: biggest
      ? { merchant: biggest.merchant, date: biggest.date, amountCents: Math.abs(biggest.amount_cents) }
      : null,
  };
}

/**
 * Build every range's buckets, category breakdown, and net income from a
 * transaction list. The category breakdown and totals describe the latest
 * bucket's full period (the current week/month/quarter/year so far).
 */
export function buildSpendingData(
  txns: SpendTxn[],
  todayISO: string,
  finishLineMonthlyCents: number | null
): SpendingData {
  const today = todayISO.slice(0, 10);
  const ranges = {} as Record<SpendingRange, SpendingPeriodData>;
  for (const range of SPENDING_RANGES) {
    const specs = specsFor(range, today);
    const buckets: SpendingBucket[] = specs.map((s) => {
      let incomeCents = 0;
      let spendCents = 0;
      for (const t of txns) {
        if (!isPosted(t)) continue;
        if (t.date < s.start || t.date > s.end) continue;
        if (t.kind === "income" && t.amount_cents > 0) incomeCents += t.amount_cents;
        else if (isSpendingKind(t.kind)) spendCents += Math.abs(t.amount_cents);
      }
      return {
        ...s,
        incomeCents,
        spendCents,
        categoryTotals: buildCategoryTotalsForWindow(txns, s.start, s.end),
      };
    });

    const latest = specs[specs.length - 1];
    const categories = buildCategoriesForWindow(txns, latest.start, latest.end);

    const totalSpendCents = categories.reduce((s, c) => s + c.spendCents, 0);
    const totalIncomeCents = buckets[buckets.length - 1].incomeCents;

    // Finish-line pace scaled to one bucket of this range.
    const AVG_MONTH_DAYS = 30.4375;
    const scale =
      range === "week" ? 7 / AVG_MONTH_DAYS : range === "quarter" ? 3 : range === "year" ? 12 : 1;
    const finishLinePerBucketCents =
      finishLineMonthlyCents != null ? Math.round(finishLineMonthlyCents * scale) : null;

    ranges[range] = {
      range,
      buckets,
      netIncomeCents: totalIncomeCents - totalSpendCents,
      totalSpendCents,
      totalIncomeCents,
      categories,
      periodLabel:
        range === "week"
          ? `Week of ${latest.label}`
          : range === "month"
            ? latest.label
            : range === "quarter"
              ? latest.label
              : latest.label,
      finishLinePerBucketCents,
    };
  }
  return { ranges, finishLineMonthlyCents };
}
