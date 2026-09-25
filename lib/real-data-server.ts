/**
 * Real-data server adapter — the ONLY path signed-in pages use to read money.
 *
 * Discipline (spec):
 *  - Session-bound client for user-readable tables (RLS: own rows).
 *  - Service client only after auth, only for plaid_items (SELECT revoked
 *    for session clients) — institution count + last sync, never tokens.
 *  - user_id on every filter, named columns, no-store, integer cents.
 *  - No demo imports anywhere in this module.
 */
import "server-only";
import { createServerSupabase, createServiceSupabase } from "./supabase/server";
import {
  isSpending,
  type TransactionKind,
} from "./ledger";
import { monthlyEquivalent, type Cadence } from "./recurring";
import { progressPct, projectedFire, targetNumberCents, monthYear } from "./fire";
import {
  DataEnvelope,
  ViewFacts,
  ViewMode,
  Provenance,
  LedgerTxn,
  Ledger,
  effectiveCategory,
  ActivityCursor,
  encodeCursor,
  decodeCursor,
  REMOVED_MARKER,
  resolveViewMode,
  missingPrerequisites,
  realDataKilled,
  validTimezone,
  localMonthStart,
  localDay,
  daysRemainingInclusive,
  localHour,
  budgetLeftPerDay,
  supportCode,
  containsDemoProvenance,
  assertNoDemoProvenance,
} from "./real-data";
import type { Brief, BriefActivity, BriefBill } from "./brief";

export const ACTIVITY_PAGE_SIZE = 50;
export const ACTIVITY_SCAN_CEILING = 500;
export const TOTAL_CATEGORY = "__total__";

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export interface Viewer {
  userId: string;
  email: string | null;
  timezone: string;
  realDataEnabled: boolean;
}

/** Authenticated viewer or null (no session). Throws on auth-service error. */
export async function getViewer(): Promise<Viewer | null> {
  const supabase = createServerSupabase();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error) {
    // No session cookie -> signed out (labeled demo), not a service failure.
    const msg = error.message ?? "";
    if (error.name === "AuthSessionMissingError" || msg.toLowerCase().includes("session missing")) {
      return null;
    }
    throw new Error(`auth-service: ${error.message}`);
  }
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("timezone, real_data_enabled")
    .eq("id", user.id)
    .maybeSingle();
  return {
    userId: user.id,
    email: user.email ?? null,
    timezone: validTimezone(profile?.timezone),
    realDataEnabled: !realDataKilled() && profile?.real_data_enabled === true,
  };
}

export async function getViewFacts(viewer: Viewer): Promise<ViewFacts> {
  const session = createServerSupabase();
  const service = createServiceSupabase();
  const { data: items } = await service
    .from("plaid_items")
    .select("status, cursor, last_sync_at")
    .eq("user_id", viewer.userId);
  const active = (items ?? []).filter((i) => i.status === "active");
  const syncCompleted = active.some((i) => i.cursor != null || i.last_sync_at != null);
  const month = localMonthStart(new Date(), viewer.timezone);
  const [{ count: txnCount }, { data: budget }, { data: fire }] = await Promise.all([
    session.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", viewer.userId),
    session
      .from("budgets")
      .select("id")
      .eq("user_id", viewer.userId)
      .eq("month", month)
      .eq("category", TOTAL_CATEGORY)
      .maybeSingle(),
    session.from("fire_settings").select("user_id").eq("user_id", viewer.userId).maybeSingle(),
  ]);
  return {
    authenticated: true,
    authError: false,
    realDataEnabled: viewer.realDataEnabled,
    hasActiveItem: active.length > 0,
    syncCompleted,
    txnCount: txnCount ?? 0,
    hasBudget: budget != null,
    hasNumber: fire != null,
  };
}

// ---------------------------------------------------------------------------
// Ledger loading (shared by Activity, Budgets, Home, Brief)
// ---------------------------------------------------------------------------

export async function loadLedger(viewer: Viewer, limit = ACTIVITY_SCAN_CEILING): Promise<Ledger> {
  const supabase = createServerSupabase();
  const [txnsRes, acctsRes, overRes, rulesRes, splitsRes] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, posted_at, ingested_at, merchant_normalized, amount_cents, kind, pending, account_id")
      .eq("user_id", viewer.userId)
      .order("posted_at", { ascending: false })
      .order("ingested_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
    supabase.from("accounts").select("id, name").eq("user_id", viewer.userId),
    supabase.from("transaction_overrides").select("transaction_id, category").eq("user_id", viewer.userId),
    supabase.from("category_rules").select("match_pattern, category").eq("user_id", viewer.userId),
    supabase.from("splits").select("transaction_id, category, amount_cents").eq("user_id", viewer.userId),
  ]);
  if (txnsRes.error) throw new Error(`ledger-read: ${txnsRes.error.message}`);
  const accountNames = new Map((acctsRes.data ?? []).map((a) => [a.id, a.name]));
  const overrides = new Map((overRes.data ?? []).map((o) => [o.transaction_id, o.category]));
  const rules = (rulesRes.data ?? []).map((r) => ({
    matchPattern: r.match_pattern,
    category: r.category,
  }));
  const splits = new Map<string, Array<{ category: string; amount_cents: number }>>();
  for (const s of splitsRes.data ?? []) {
    const arr = splits.get(s.transaction_id) ?? [];
    arr.push({ category: s.category, amount_cents: s.amount_cents });
    splits.set(s.transaction_id, arr);
  }
  return { txns: (txnsRes.data ?? []) as LedgerTxn[], accountNames, overrides, rules, splits };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityRow {
  id: string;
  postedAt: string;
  merchant: string;
  amountCents: number;
  category: string;
  kind: TransactionKind;
  pending: boolean;
  accountName: string | null;
}

export type ActivityFilter = "all" | "spending" | "income" | "transfer" | "pending";

export interface ActivityData {
  rows: ActivityRow[];
  nextCursor: string | null;
  totalScanned: number;
}

function toActivityRow(ledger: Ledger, txn: LedgerTxn): ActivityRow {
  const { category } = effectiveCategory(ledger, txn);
  return {
    id: txn.id,
    postedAt: txn.posted_at,
    merchant: txn.merchant_normalized,
    amountCents: txn.amount_cents,
    category,
    kind: txn.kind,
    pending: txn.pending,
    accountName: txn.account_id ? ledger.accountNames.get(txn.account_id) ?? null : null,
  };
}

export async function loadActivity(
  viewer: Viewer,
  opts: { cursor?: string | null; filter?: ActivityFilter; q?: string }
): Promise<DataEnvelope<ActivityData>> {
  const asOf = new Date().toISOString();
  const mode: ViewMode = "real";
  try {
    const facts = await getViewFacts(viewer);
    const pageMode = resolveViewMode(facts);
    if (pageMode !== "real" && pageMode !== "partial") {
      return {
        mode: pageMode,
        as_of: asOf,
        timezone: viewer.timezone,
        provenance: { rows: "missing" },
        data: { rows: [], nextCursor: null, totalScanned: 0 },
        missing: missingPrerequisites(facts),
      };
    }
    const filter: ActivityFilter = opts.filter ?? "all";
    const q = (opts.q ?? "").trim().toLowerCase();
    const ledger = await loadLedger(viewer, ACTIVITY_SCAN_CEILING);
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

    // Keyset window: deterministic order posted_at desc, ingested_at desc, id desc.
    let window = ledger.txns;
    if (cursor) {
      window = window.filter(
        (t) =>
          t.posted_at < cursor.posted_at ||
          (t.posted_at === cursor.posted_at &&
            (t.ingested_at < cursor.ingested_at ||
              (t.ingested_at === cursor.ingested_at && t.id < cursor.id)))
      );
    }
    // Removal exclusion is a JS filter (override-driven); the cursor advances
    // on fetched rows so pagination can never skip or duplicate.
    const kept = window.filter((t) => !effectiveCategory(ledger, t).removed);
    const scanned = kept.slice(0, ACTIVITY_SCAN_CEILING);
    const truncated = window.length > ACTIVITY_SCAN_CEILING;

    const matches = (row: ActivityRow): boolean => {
      if (filter === "spending" && !isSpending(row.kind)) return false;
      if (filter === "income" && !(row.kind === "income" || row.kind === "refund")) return false;
      if (filter === "transfer" && row.kind !== "transfer") return false;
      if (filter === "pending" && !row.pending) return false;
      if (q && !row.merchant.toLowerCase().includes(q) && !row.category.toLowerCase().includes(q))
        return false;
      return true;
    };

    const rows: ActivityRow[] = [];
    for (const t of scanned) {
      const row = toActivityRow(ledger, t);
      if (matches(row)) {
        rows.push(row);
        if (rows.length >= ACTIVITY_PAGE_SIZE) break;
      }
    }
    // Cursor advances on the last *fetched* row so short pages (removals)
    // never cause skips.
    const lastFetched = scanned[Math.min(rows.length, scanned.length) - 1] ?? scanned[scanned.length - 1];
    const hasMore = cursor
      ? window.length > 0 && rows.length > 0
      : kept.length > rows.length;
    const nextCursor =
      rows.length > 0 && hasMore && lastFetched
        ? encodeCursor({ posted_at: lastFetched.posted_at, ingested_at: lastFetched.ingested_at, id: lastFetched.id })
        : null;

    return {
      mode,
      as_of: asOf,
      timezone: viewer.timezone,
      provenance: { rows: "real" },
      data: { rows, nextCursor, totalScanned: scanned.length },
      missing: missingPrerequisites(facts),
      truncated,
    };
  } catch (e) {
    return errorEnvelope<ActivityData>("rows", viewer.timezone, { rows: [], nextCursor: null, totalScanned: 0 });
  }
}

function errorEnvelope<T>(section: string, timezone: string, data: T): DataEnvelope<T> {
  return {
    mode: "error",
    as_of: new Date().toISOString(),
    timezone,
    provenance: { [section]: "error" },
    data,
    missing: [],
    support_code: supportCode(),
  };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface BudgetCategoryRow {
  category: string;
  limitCents: number;
  spentCents: number;
  txnCount: number;
}

export interface BudgetMonthData {
  month: string; // YYYY-MM-DD first of month
  monthLabel: string;
  ceilingCents: number | null;
  spentCents: number;
  /** Pro-rata expected spend by elapsed calendar days (ceiling only). */
  expectedCents: number | null;
  elapsedDays: number;
  categories: BudgetCategoryRow[];
  unbudgeted: { spentCents: number; txnCount: number; categories: string[] };
  daysRemaining: number;
  perDayCents: number | null;
}

export async function loadBudgetMonth(viewer: Viewer, now = new Date()): Promise<DataEnvelope<BudgetMonthData>> {
  const month = localMonthStart(now, viewer.timezone);
  try {
    const facts = await getViewFacts(viewer);
    const pageMode = resolveViewMode(facts);
    if (pageMode !== "real" && pageMode !== "partial") {
      return {
        mode: pageMode,
        as_of: now.toISOString(),
        timezone: viewer.timezone,
        provenance: { budget: "missing" },
        data: emptyBudgetMonth(month, viewer.timezone, now),
        missing: missingPrerequisites(facts),
      };
    }
    const supabase = createServerSupabase();
    const { data: limits, error } = await supabase
      .from("budgets")
      .select("category, limit_cents")
      .eq("user_id", viewer.userId)
      .eq("month", month);
    if (error) throw new Error(`budget-read: ${error.message}`);

    const ledger = await loadLedger(viewer);
    const monthPrefix = month.slice(0, 7);
    const ceiling = limits?.find((l) => l.category === TOTAL_CATEGORY)?.limit_cents ?? null;
    const categoryLimits = new Map((limits ?? []).filter((l) => l.category !== TOTAL_CATEGORY).map((l) => [l.category, l.limit_cents]));

    const spentByCat = new Map<string, { spent: number; count: number }>();
    let spentTotal = 0;
    for (const t of ledger.txns) {
      if (t.posted_at.slice(0, 7) !== monthPrefix) continue;
      if (!isSpending(t.kind) || t.pending) continue;
      const eff = effectiveCategory(ledger, t);
      if (eff.removed) continue;
      const out = Math.abs(t.amount_cents);
      if (eff.split) {
        for (const s of ledger.splits.get(t.id) ?? []) {
          const cur = spentByCat.get(s.category) ?? { spent: 0, count: 0 };
          cur.spent += s.amount_cents;
          cur.count += 1;
          spentByCat.set(s.category, cur);
        }
        spentTotal += out;
        continue;
      }
      const cur = spentByCat.get(eff.category) ?? { spent: 0, count: 0 };
      cur.spent += out;
      cur.count += 1;
      spentByCat.set(eff.category, cur);
      spentTotal += out;
    }

    const categories: BudgetCategoryRow[] = [];
    const unbudgetedCats: string[] = [];
    let unbudgetedSpent = 0;
    let unbudgetedCount = 0;
    for (const [cat, { spent, count }] of spentByCat) {
      if (categoryLimits.has(cat)) {
        categories.push({ category: cat, limitCents: categoryLimits.get(cat)!, spentCents: spent, txnCount: count });
      } else {
        unbudgetedSpent += spent;
        unbudgetedCount += count;
        unbudgetedCats.push(cat);
      }
    }
    for (const [cat, limit] of categoryLimits) {
      if (!spentByCat.has(cat)) categories.push({ category: cat, limitCents: limit, spentCents: 0, txnCount: 0 });
    }
    categories.sort((a, b) => b.spentCents - a.spentCents);

    const daysRemaining = daysRemainingInclusive(now, viewer.timezone);
    const [my, mm] = month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(my, mm, 0)).getUTCDate();
    const elapsedDays = Math.max(1, daysInMonth - daysRemaining + 1);
    const expectedCents = ceiling != null ? Math.floor((ceiling * elapsedDays) / daysInMonth) : null;
    const data: BudgetMonthData = {
      month,
      monthLabel: monthYear(month),
      ceilingCents: ceiling,
      spentCents: spentTotal,
      expectedCents,
      elapsedDays,
      categories,
      unbudgeted: { spentCents: unbudgetedSpent, txnCount: unbudgetedCount, categories: unbudgetedCats.sort() },
      daysRemaining,
      perDayCents: ceiling != null ? budgetLeftPerDay({ ceilingCents: ceiling, postedSpendingCents: spentTotal, daysRemaining }) : null,
    };
    const env: DataEnvelope<BudgetMonthData> = {
      mode: pageMode,
      as_of: now.toISOString(),
      timezone: viewer.timezone,
      provenance: { budget: ceiling != null ? "real" : "missing" },
      data,
      missing: missingPrerequisites(facts),
    };
    if (process.env.NODE_ENV !== "production") assertNoDemo(env, "budgets");
    else if (containsDemoProvenance(env)) return errorEnvelope<BudgetMonthData>("budget", viewer.timezone, emptyBudgetMonth(month, viewer.timezone, now));
    return env;
  } catch {
    return errorEnvelope<BudgetMonthData>("budget", viewer.timezone, emptyBudgetMonth(month, viewer.timezone, now));
  }
}

function assertNoDemo(env: DataEnvelope<unknown>, surface: string) {
  assertNoDemoProvenance(env, surface);
}

function emptyBudgetMonth(month: string, timezone: string, now: Date): BudgetMonthData {
  return {
    month,
    monthLabel: monthYear(month),
    ceilingCents: null,
    spentCents: 0,
    expectedCents: null,
    elapsedDays: 1,
    categories: [],
    unbudgeted: { spentCents: 0, txnCount: 0, categories: [] },
    daysRemaining: daysRemainingInclusive(now, timezone),
    perDayCents: null,
  };
}

export interface BudgetDrilldownData {
  month: string;
  category: string; // "__total__" for all spending
  limitCents: number | null;
  spentCents: number;
  rows: ActivityRow[];
}

/**
 * Category drilldown: biggest-first rows for the month using the same real
 * transaction set and effective categories as Activity.
 */
export async function loadBudgetDrilldown(
  viewer: Viewer,
  category: string,
  now = new Date()
): Promise<DataEnvelope<BudgetDrilldownData>> {
  const month = localMonthStart(now, viewer.timezone);
  const monthPrefix = month.slice(0, 7);
  try {
    const ledger = await loadLedger(viewer);
    const supabase = createServerSupabase();
    const { data: limits } = await supabase
      .from("budgets")
      .select("category, limit_cents")
      .eq("user_id", viewer.userId)
      .eq("month", month);
    const limitCents =
      category === TOTAL_CATEGORY
        ? limits?.find((l) => l.category === TOTAL_CATEGORY)?.limit_cents ?? null
        : limits?.find((l) => l.category === category)?.limit_cents ?? null;

    const rows: ActivityRow[] = [];
    for (const t of ledger.txns) {
      if (t.posted_at.slice(0, 7) !== monthPrefix) continue;
      if (!isSpending(t.kind) || t.pending) continue;
      const eff = effectiveCategory(ledger, t);
      if (eff.removed) continue;
      if (category !== TOTAL_CATEGORY && eff.category !== category) continue;
      rows.push(toActivityRow(ledger, t));
    }
    rows.sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
    const spentCents = rows.reduce((s, r) => s + Math.abs(r.amountCents), 0);
    const env: DataEnvelope<BudgetDrilldownData> = {
      mode: "real",
      as_of: now.toISOString(),
      timezone: viewer.timezone,
      provenance: { drilldown: "real" },
      data: { month, category, limitCents, spentCents, rows: rows.slice(0, 50) },
      missing: [],
    };
    if (process.env.NODE_ENV !== "production") assertNoDemo(env, "budget-drilldown");
    return env;
  } catch {
    return errorEnvelope<BudgetDrilldownData>("drilldown", viewer.timezone, {
      month,
      category,
      limitCents: null,
      spentCents: 0,
      rows: [],
    });
  }
}

/** Upsert the monthly ceiling and/or category limits. Returns the month view. */
export async function saveBudgetLimits(
  viewer: Viewer,
  input: { month: string; ceilingCents?: number; categories?: Array<{ category: string; limitCents: number }> }
): Promise<DataEnvelope<BudgetMonthData>> {
  if (!/^\d{4}-\d{2}-01$/.test(input.month)) {
    return errorEnvelope<BudgetMonthData>("budget", viewer.timezone, emptyBudgetMonth(input.month, viewer.timezone, new Date()));
  }
  const rows: Array<{ user_id: string; month: string; category: string; limit_cents: number }> = [];
  const push = (category: string, limitCents: number) => {
    if (!Number.isInteger(limitCents) || limitCents < 0) throw new Error("limit_cents must be a non-negative integer");
    if (!category || category.length > 64) throw new Error("invalid category");
    rows.push({ user_id: viewer.userId, month: input.month, category, limit_cents: limitCents });
  };
  try {
    if (input.ceilingCents !== undefined) push(TOTAL_CATEGORY, input.ceilingCents);
    for (const c of input.categories ?? []) push(c.category, c.limitCents);
    if (rows.length === 0) throw new Error("nothing to save");
    const supabase = createServerSupabase();
    const { error } = await supabase
      .from("budgets")
      .upsert(rows, { onConflict: "user_id,month,category" });
    if (error) throw new Error(`budget-write: ${error.message}`);
    return loadBudgetMonth(viewer);
  } catch {
    return errorEnvelope<BudgetMonthData>("budget", viewer.timezone, emptyBudgetMonth(input.month, viewer.timezone, new Date()));
  }
}

// ---------------------------------------------------------------------------
// Home dashboard
// ---------------------------------------------------------------------------

export interface HomeData {
  number: {
    provenance: Provenance;
    targetCents: number | null;
    progressPct: number | null;
    arrivalLabel: string | null;
    monthlySavingsCents: number | null;
  };
  budgetLeft: {
    provenance: Provenance;
    perDayCents: number | null;
    overByCents: number;
  };
  recurring: {
    provenance: Provenance;
    totalMonthlyCents: number;
    count: number;
    priceHikes: Array<{ merchant: string; prevCents: number; nowCents: number }>;
    learning: boolean;
  };
  connection: {
    provenance: Provenance;
    institutionCount: number;
    lastSyncAt: string | null;
    hasActiveItem: boolean;
  };
}

export async function loadHome(viewer: Viewer, now = new Date()): Promise<DataEnvelope<HomeData>> {
  try {
    const facts = await getViewFacts(viewer);
    const pageMode = resolveViewMode(facts);
    if (pageMode !== "real" && pageMode !== "partial" && pageMode !== "setup" && pageMode !== "syncing") {
      return {
        mode: pageMode,
        as_of: now.toISOString(),
        timezone: viewer.timezone,
        provenance: { home: pageMode === "error" ? "error" : "missing" },
        data: emptyHome(),
        missing: missingPrerequisites(facts),
        ...(pageMode === "error" ? { support_code: supportCode() } : {}),
      };
    }
    const session = createServerSupabase();
    const service = createServiceSupabase();
    const [fireRes, budgetEnv, recurRes, itemsRes] = await Promise.all([
      session.from("fire_settings").select("annual_spending_cents, portfolio_cents, monthly_savings_cents, expected_return_pct, target_number_cents").eq("user_id", viewer.userId).maybeSingle(),
      loadBudgetMonth(viewer, now),
      session.from("recurring").select("merchant_normalized, amount_cents_avg, last_amount_cents, cadence, price_changed, dismissed").eq("user_id", viewer.userId),
      service.from("plaid_items").select("institution_name, status, last_sync_at").eq("user_id", viewer.userId),
    ]);
    if (fireRes.error) throw new Error(`fire-read: ${fireRes.error.message}`);
    if (recurRes.error) throw new Error(`recurring-read: ${recurRes.error.message}`);

    const fire = fireRes.data;
    const number = fire
      ? (() => {
          const target = fire.target_number_cents ?? targetNumberCents(fire.annual_spending_cents);
          const proj = projectedFire({
            portfolioCents: fire.portfolio_cents,
            monthlySavingsCents: fire.monthly_savings_cents,
            annualReturnPct: Number(fire.expected_return_pct),
            targetCents: target,
          });
          return {
            provenance: "real" as Provenance,
            targetCents: target,
            progressPct: progressPct(fire.portfolio_cents, target),
            arrivalLabel: proj.reachable && proj.dateISO ? monthYear(proj.dateISO) : null,
            monthlySavingsCents: fire.monthly_savings_cents,
          };
        })()
      : { provenance: "missing" as Provenance, targetCents: null, progressPct: null, arrivalLabel: null, monthlySavingsCents: null };

    const b = budgetEnv.data;
    const overBy = b.ceilingCents != null ? Math.max(0, b.spentCents - b.ceilingCents) : 0;
    const budgetLeft = {
      provenance: (b.ceilingCents != null ? "real" : "missing") as Provenance,
      perDayCents: b.perDayCents,
      overByCents: overBy,
    };

    const active = (recurRes.data ?? []).filter((r) => !r.dismissed);
    const totalMonthlyCents = active.reduce(
      (s, r) => s + monthlyEquivalent(r.last_amount_cents, r.cadence as Cadence),
      0
    );
    const priceHikes = active
      .filter((r) => r.price_changed)
      .map((r) => ({ merchant: r.merchant_normalized, prevCents: r.amount_cents_avg, nowCents: r.last_amount_cents }));
    const items = itemsRes.data ?? [];
    const activeItems = items.filter((i) => i.status === "active");
    const lastSyncAt = activeItems.map((i) => i.last_sync_at).filter(Boolean).sort().pop() ?? null;

    const env: DataEnvelope<HomeData> = {
      mode: pageMode,
      as_of: now.toISOString(),
      timezone: viewer.timezone,
      provenance: {
        number: number.provenance,
        budgetLeft: budgetLeft.provenance,
        recurring: active.length > 0 || facts.syncCompleted ? "real" : "missing",
        connection: "real",
      },
      data: {
        number,
        budgetLeft,
        recurring: {
          provenance: active.length > 0 || facts.syncCompleted ? "real" : "missing",
          totalMonthlyCents,
          count: active.length,
          priceHikes,
          learning: facts.syncCompleted && active.length === 0,
        },
        connection: {
          provenance: "real",
          institutionCount: activeItems.length,
          lastSyncAt,
          hasActiveItem: activeItems.length > 0,
        },
      },
      missing: missingPrerequisites(facts),
    };
    if (process.env.NODE_ENV !== "production") assertNoDemo(env, "home");
    else if (containsDemoProvenance(env)) return errorEnvelope<HomeData>("home", viewer.timezone, emptyHome());
    return env;
  } catch {
    return errorEnvelope<HomeData>("home", viewer.timezone, emptyHome());
  }
}

function emptyHome(): HomeData {
  return {
    number: { provenance: "missing", targetCents: null, progressPct: null, arrivalLabel: null, monthlySavingsCents: null },
    budgetLeft: { provenance: "missing", perDayCents: null, overByCents: 0 },
    recurring: { provenance: "missing", totalMonthlyCents: 0, count: 0, priceHikes: [], learning: false },
    connection: { provenance: "missing", institutionCount: 0, lastSyncAt: null, hasActiveItem: false },
  };
}

// ---------------------------------------------------------------------------
// Morning Brief (real assembler)
// ---------------------------------------------------------------------------

export interface RealBriefData {
  brief: Brief;
  /** Prerequisite labels for modules that could not render. */
  missing: string[];
}

function greetingFor(now: Date, tz: string): string {
  const h = localHour(now, tz);
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export async function loadRealBrief(viewer: Viewer, now = new Date()): Promise<DataEnvelope<RealBriefData>> {
  const service = createServiceSupabase();
  try {
    const facts = await getViewFacts(viewer);
    const pageMode = resolveViewMode(facts);
    if (pageMode !== "real" && pageMode !== "partial") {
      const empty = emptyBrief(now, viewer.timezone);
      return {
        mode: pageMode,
        as_of: now.toISOString(),
        timezone: viewer.timezone,
        provenance: { brief: pageMode === "error" ? "error" : "missing" },
        data: { brief: empty, missing: missingPrerequisites(facts) },
        missing: missingPrerequisites(facts),
        ...(pageMode === "error" ? { support_code: supportCode() } : {}),
      };
    }

    // Read-state transaction: read prior boundary FIRST; advance only after
    // successful assembly.
    const session = createServerSupabase();
    const { data: readRow } = await session
      .from("brief_reads")
      .select("last_read_at")
      .eq("user_id", viewer.userId)
      .maybeSingle();
    const priorRead = readRow?.last_read_at ? new Date(readRow.last_read_at) : null;

    const ledger = await loadLedger(viewer);
    const [fireRes, budgetEnv, recurRes] = await Promise.all([
      session.from("fire_settings").select("annual_spending_cents, portfolio_cents, monthly_savings_cents, expected_return_pct, target_number_cents").eq("user_id", viewer.userId).maybeSingle(),
      loadBudgetMonth(viewer, now),
      session.from("recurring").select("merchant_normalized, amount_cents_avg, last_amount_cents, cadence, next_charge_date, price_changed, dismissed").eq("user_id", viewer.userId),
    ]);

    const today = localDay(now, viewer.timezone);
    const in7 = (() => {
      const d = new Date(now);
      d.setDate(d.getDate() + 7);
      return localDay(d, viewer.timezone);
    })();

    // New activity: non-transfer rows ingested since prior read (first read:
    // newest 8 ingested within the previous 7 days).
    const cutoff = priorRead ?? new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const fresh = ledger.txns
      .filter((t) => new Date(t.ingested_at) > cutoff && t.kind !== "transfer" && !effectiveCategory(ledger, t).removed)
      .slice(0, 8);
    const newActivity: BriefActivity[] = fresh.map((t) => ({
      id: t.id,
      merchant: t.merchant_normalized,
      amountCents: t.amount_cents,
      kind: t.kind,
      pending: t.pending,
    }));
    const newActivityTotalCents = fresh
      .filter((t) => !t.pending && isSpending(t.kind))
      .reduce((s, t) => s + t.amount_cents, 0);
    const pendingCount = fresh.filter((t) => t.pending).length;

    // Bills due this week.
    const active = (recurRes.data ?? []).filter((r) => !r.dismissed);
    const billsDue: BriefBill[] = active
      .filter((r) => r.next_charge_date && r.next_charge_date >= today && r.next_charge_date <= in7)
      .map((r) => ({
        merchant: r.merchant_normalized,
        amountCents: r.last_amount_cents,
        dueDate: r.next_charge_date!,
        priceChanged: r.price_changed,
        prevAmountCents: r.price_changed ? r.amount_cents_avg : null,
      }));
    const billsDueTotalCents = billsDue.reduce((s, b) => s + b.amountCents, 0);

    // Budget pace (only with a ceiling).
    const b = budgetEnv.data;
    const daysInMonth = Number(today.split("-")[2]) + b.daysRemaining - 1;
    const elapsed = Math.max(1, daysInMonth - b.daysRemaining + 1);
    const budgetExpectedCents =
      b.ceilingCents != null ? Math.floor((b.ceilingCents * elapsed) / Math.max(1, daysInMonth)) : 0;

    // Subscription watch.
    const priceChanges: BriefBill[] = active
      .filter((r) => r.price_changed)
      .map((r) => ({
        merchant: r.merchant_normalized,
        amountCents: r.last_amount_cents,
        dueDate: r.next_charge_date ?? today,
        priceChanged: true,
        prevAmountCents: r.amount_cents_avg,
      }));
    const monthlyRecurringCents = active.reduce(
      (s, r) => s + monthlyEquivalent(r.last_amount_cents, r.cadence as Cadence),
      0
    );

    // Number nudge (only with saved settings).
    const fire = fireRes.data;
    let fireProgressPct = 0;
    let fireTargetCents = 0;
    let fireNudge = "";
    let fireArrival = "";
    if (fire) {
      const target = fire.target_number_cents ?? targetNumberCents(fire.annual_spending_cents);
      fireProgressPct = progressPct(fire.portfolio_cents, target);
      fireTargetCents = target;
      const proj = projectedFire({
        portfolioCents: fire.portfolio_cents,
        monthlySavingsCents: fire.monthly_savings_cents,
        annualReturnPct: Number(fire.expected_return_pct),
        targetCents: target,
      });
      fireArrival = proj.reachable && proj.dateISO ? monthYear(proj.dateISO) : "not on track";
      fireNudge = proj.reachable && proj.dateISO
        ? `On track for ${monthYear(proj.dateISO)} at your current pace.`
        : "Not on track under current assumptions — the What-If Planner can show what closes the gap.";
    }

    const missing: string[] = [];
    if (b.ceilingCents == null) missing.push("budget");
    if (!fire) missing.push("number");

    const modulesQuiet =
      newActivity.length === 0 && billsDue.length === 0 && priceChanges.length === 0;
    const quiet = modulesQuiet && missing.length === 0;

    const brief: Brief = {
      asOf: today,
      greeting: greetingFor(now, viewer.timezone),
      newActivity,
      newActivityTotalCents,
      pendingCount,
      billsDue,
      billsDueTotalCents,
      budgetMonth: b.monthLabel,
      budgetSpentCents: b.ceilingCents != null ? b.spentCents : 0,
      budgetLimitCents: b.ceilingCents ?? 0,
      budgetExpectedCents,
      priceChanges,
      monthlyRecurringCents,
      fireProgressPct,
      fireTargetCents,
      fireNudge,
      fireArrival,
      quiet,
    };

    // Advance the read timestamp ONLY after successful assembly.
    await service
      .from("brief_reads")
      .upsert({ user_id: viewer.userId, last_read_at: now.toISOString(), updated_at: now.toISOString() }, { onConflict: "user_id" });

    const { logPilotEvent } = await import("./analytics-server");
    await logPilotEvent(viewer.userId, "morning_brief_viewed", { mode: "real" }).catch(() => {});

    const env: DataEnvelope<RealBriefData> = {
      mode: pageMode,
      as_of: now.toISOString(),
      timezone: viewer.timezone,
      provenance: {
        brief: "real",
        budget: b.ceilingCents != null ? "real" : "missing",
        number: fire ? "real" : "missing",
      },
      data: { brief, missing },
      missing: missingPrerequisites(facts),
    };
    if (process.env.NODE_ENV !== "production") assertNoDemo(env, "brief");
    else if (containsDemoProvenance(env)) return errorEnvelope<RealBriefData>("brief", viewer.timezone, { brief: emptyBrief(now, viewer.timezone), missing: [] });
    return env;
  } catch {
    return errorEnvelope<RealBriefData>("brief", viewer.timezone, { brief: emptyBrief(now, viewer.timezone), missing: [] });
  }
}

function emptyBrief(now: Date, tz: string): Brief {
  return {
    asOf: localDay(now, tz),
    greeting: greetingFor(now, tz),
    newActivity: [],
    newActivityTotalCents: 0,
    pendingCount: 0,
    billsDue: [],
    billsDueTotalCents: 0,
    budgetMonth: "",
    budgetSpentCents: 0,
    budgetLimitCents: 0,
    budgetExpectedCents: 0,
    priceChanges: [],
    monthlyRecurringCents: 0,
    fireProgressPct: 0,
    fireTargetCents: 0,
    fireNudge: "",
    fireArrival: "",
    quiet: false,
  };
}
