/**
 * Real-data UI milestone — pure domain layer (no I/O, fully testable).
 *
 * Two product modes:
 *   Signed-out demo — seeded data, always labeled, explains the product.
 *   Signed-in Coast  — the user's own rows or honest missing/error states.
 *                     NEVER seeded values.
 *
 * Pages consume provenance-tagged view models. The authenticated branch has
 * no import path to demo values; assertNoDemoProvenance() is the guard.
 */

export type ViewMode =
  | "demo"
  | "setup"
  | "syncing"
  | "real"
  | "partial"
  | "error"
  | "unavailable";

export type Provenance = "demo" | "real" | "missing" | "error";

/** Common envelope for authenticated data responses. */
export interface DataEnvelope<T> {
  mode: ViewMode;
  as_of: string; // ISO timestamp, server clock
  timezone: string; // validated IANA name
  provenance: Record<string, Provenance>;
  data: T;
  /** Prerequisite labels: "bank" | "budget" | "number" | "recurring-history" */
  missing: string[];
  /** Present only on operational errors; safe to show to support. */
  support_code?: string;
  truncated?: boolean;
}

/** Facts the server collects before resolving a view state. */
export interface ViewFacts {
  authenticated: boolean;
  /** The auth service itself errored (distinct from "no session"). */
  authError: boolean;
  /** Kill switch AND per-profile flag. */
  realDataEnabled: boolean;
  hasActiveItem: boolean;
  /** A sync completed at least once (cursor or last_sync_at present). */
  syncCompleted: boolean;
  txnCount: number;
  hasBudget: boolean;
  hasNumber: boolean;
}

/**
 * Deterministic view-state resolution (spec: "A deterministic state model
 * replaces fallback logic").
 */
export function resolveViewMode(f: ViewFacts): ViewMode {
  if (f.authError) return "error";
  if (!f.authenticated) return "demo";
  if (!f.realDataEnabled) return "unavailable"; // fail closed, never demo
  if (!f.hasActiveItem) return "setup";
  if (!f.syncCompleted && f.txnCount === 0) return "syncing";
  if (f.txnCount === 0) return "partial"; // completed sync, zero rows
  if (!f.hasBudget || !f.hasNumber) return "partial";
  return "real";
}

/** Missing-prerequisite labels for a resolved fact set. */
export function missingPrerequisites(f: ViewFacts): string[] {
  const missing: string[] = [];
  if (!f.hasActiveItem) missing.push("bank");
  if (!f.hasBudget) missing.push("budget");
  if (!f.hasNumber) missing.push("number");
  return missing;
}

/**
 * Guard: walk an envelope's provenance map and report any demo leakage.
 * In dev this throws so bad call sites fail fast; route handlers use the
 * boolean to convert the response into an error state in production.
 */
export function containsDemoProvenance(env: { provenance: Record<string, Provenance> }): boolean {
  return Object.values(env.provenance).some((p) => p === "demo");
}

export function assertNoDemoProvenance(
  env: { provenance: Record<string, Provenance> },
  surface: string
): void {
  if (containsDemoProvenance(env)) {
    throw new Error(`[real-data] demo provenance leaked into signed-in surface: ${surface}`);
  }
}

/** Fail-closed kill switch. Anything but explicit "off" keeps real data on. */
export function realDataKilled(): boolean {
  return process.env.COAST_REAL_DATA === "off";
}

/** Short, safe operational code for user-visible errors. */
export function supportCode(): string {
  return Math.random().toString(16).slice(2, 8).toUpperCase().padStart(6, "0");
}

// ---------------------------------------------------------------------------
// Timezone-aware calendar helpers (profile timezone, never browser time).
// ---------------------------------------------------------------------------

const IANA_PATTERN = /^[A-Za-z_]+\/[A-Za-z0-9_\-+]+(\/[A-Za-z0-9_\-+]+)?$/;

export function validTimezone(tz: string | null | undefined, fallback = "America/Chicago"): string {
  if (tz && IANA_PATTERN.test(tz)) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** "YYYY-MM" for the user's local month. */
export function localMonthKey(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}`;
}

/** First-of-month date string "YYYY-MM-DD" for the user's local month. */
export function localMonthStart(now: Date, tz: string): string {
  return `${localMonthKey(now, tz)}-01`;
}

/** Local calendar day "YYYY-MM-DD". */
export function localDay(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Inclusive days remaining in the local month; never below 1. */
export function daysRemainingInclusive(now: Date, tz: string): number {
  const today = localDay(now, tz);
  const [y, m] = today.split("-").map(Number);
  // Days in month via UTC to avoid DST edge cases.
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dayOfMonth = Number(today.split("-")[2]);
  return Math.max(1, daysInMonth - dayOfMonth + 1);
}

/** Local hour (0-23) for greetings. */
export function localHour(now: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now)
  ) % 24;
}

// ---------------------------------------------------------------------------
// Budget-left-per-day (the V1 replacement for "safe to spend").
// Formula: max(0, ceiling − posted spending) / inclusive days remaining,
// rounded DOWN to cents. Pending, transfers, income, refunds excluded
// by the caller (posted spending = expense + fee outflows only).
// ---------------------------------------------------------------------------

export function budgetLeftPerDay(args: {
  ceilingCents: number;
  postedSpendingCents: number;
  daysRemaining: number;
}): number {
  const days = Math.max(1, Math.floor(args.daysRemaining));
  const left = Math.max(0, args.ceilingCents - args.postedSpendingCents);
  return Math.floor(left / days);
}

// ---------------------------------------------------------------------------
// Sentinel values — known demo merchants/amounts. Tests assert these NEVER
// appear in signed-in view models, rendered HTML, or API payloads.
// ---------------------------------------------------------------------------

export const DEMO_SENTINEL_MERCHANTS = [
  "Whole Foods",
  "Target",
  "Uber",
  "United Airlines",
  "HEB",
  "CVS",
  "Dentist Copay",
  "Venmo — split dinner",
] as const;

export const DEMO_SENTINEL_AMOUNTS = [
  -28196, -10619, -10479, -9990, -8420, -7533, -5907, -5792, -3745, -3637, -2565, -2465,
  12000000, 15000000, 500000,
] as const;

/** True if any sentinel merchant or amount appears anywhere in the JSON. */
export function containsDemoSentinel(value: unknown): boolean {
  const json = JSON.stringify(value);
  for (const m of DEMO_SENTINEL_MERCHANTS) {
    if (json.includes(`"${m}"`)) return true;
  }
  for (const a of DEMO_SENTINEL_AMOUNTS) {
    if (json.includes(`${a}`)) {
      // Amounts need a boundary check to avoid substring false positives.
      const re = new RegExp(`[^0-9]${a}[^0-9]`);
      if (re.test(` ${json} `)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ledger view types + effective category (pure; shared by server + tests).
// ---------------------------------------------------------------------------

export interface LedgerTxn {
  id: string;
  posted_at: string;
  ingested_at: string;
  merchant_normalized: string;
  amount_cents: number;
  kind: TransactionKind;
  pending: boolean;
  account_id: string | null;
}

export interface Ledger {
  txns: LedgerTxn[];
  accountNames: Map<string, string>;
  overrides: Map<string, string>; // transaction_id -> category
  rules: Array<{ matchPattern: string; category: string }>;
  splits: Map<string, Array<{ category: string; amount_cents: number }>>;
}

export const REMOVED_MARKER = "REMOVED_BY_BANK";

import { resolveCategory, type TransactionKind } from "./ledger";

/**
 * Effective category: bank-removal marker -> split -> override -> rule ->
 * deterministic default map (the last three via lib/ledger).
 */
export function effectiveCategory(
  ledger: Ledger,
  txn: LedgerTxn
): { category: string; removed: boolean; split: boolean } {
  const override = ledger.overrides.get(txn.id) ?? null;
  if (override === REMOVED_MARKER) return { category: REMOVED_MARKER, removed: true, split: false };
  const splitRows = ledger.splits.get(txn.id);
  if (splitRows && splitRows.length > 0) {
    return { category: "Split", removed: false, split: true };
  }
  return {
    category: resolveCategory({
      merchantNormalized: txn.merchant_normalized,
      override,
      rules: ledger.rules,
    }),
    removed: false,
    split: false,
  };
}

// ---------------------------------------------------------------------------
// Opaque cursor for Activity pagination (pure encode/decode).
// ---------------------------------------------------------------------------

export interface ActivityCursor {
  posted_at: string;
  ingested_at: string;
  id: string;
}

export function encodeCursor(c: ActivityCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(s: string): ActivityCursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof c.posted_at === "string" && typeof c.ingested_at === "string" && typeof c.id === "string")
      return c;
    return null;
  } catch {
    return null;
  }
}
