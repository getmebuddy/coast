/**
 * Routines server adapter — detection runs, findings, and refund tracking.
 *
 * SERVER ONLY. Signed-in paths only; session client enforces RLS (own rows).
 * Detection is idempotent: findings upsert on (user_id, routine_key,
 * dedupe_hash) and never resurrect resolved/dismissed/snoozed findings.
 * Notify-tier only — nothing here moves money or contacts anyone.
 */
import "server-only";
import { createServerSupabase } from "./supabase/server";
import { loadLedger, type Viewer } from "./real-data-server";
import {
  ROUTINE_REGISTRY,
  detectDuplicates,
  detectFeeSweep,
  detectOverlap,
  detectPossibleTrials,
  detectPriceHikes,
  matchRefunds,
  type ExpectedRefund,
  type RoutineFinding,
  type RoutineKey,
  type RoutineTxn,
} from "./routines";
import { logPilotEvent } from "./analytics-server";

export interface RoutineRow {
  key: string;
  name: string;
  enabled: boolean;
}

export interface FindingRow {
  id: string;
  routine_key: string;
  kind: string;
  title: string;
  detail: string;
  impact_cents: number;
  evidence: RoutineFinding["evidence"];
  status: string;
  snoozed_until: string | null;
  created_at: string;
}

export interface RunRow {
  id: string;
  routine_key: string;
  ran_at: string;
  checked_count: number;
  findings_count: number;
  note: string;
}

export interface ExpectedRefundRow {
  id: string;
  merchant: string;
  amount_cents: number;
  expected_date: string;
  status: "pending" | "matched" | "shortfall";
  created_at: string;
}

function toRoutineTxn(t: {
  id: string;
  merchant_normalized: string;
  amount_cents: number;
  posted_at: string;
  kind: string;
  pending: boolean;
}): RoutineTxn {
  return {
    id: t.id,
    merchant: t.merchant_normalized,
    amount_cents: t.amount_cents,
    date: t.posted_at.slice(0, 10),
    kind: t.kind,
    pending: t.pending,
  };
}

/** Seed the registry rows for a user; returns all routines with flags. */
export async function listRoutines(userId: string): Promise<RoutineRow[]> {
  const supabase = createServerSupabase();
  const { data: existing } = await supabase
    .from("routines")
    .select("key, name, enabled")
    .eq("user_id", userId);
  const have = new Set((existing ?? []).map((r) => r.key));
  const missing = ROUTINE_REGISTRY.filter((r) => !have.has(r.key));
  if (missing.length > 0) {
    const { error } = await supabase.from("routines").insert(
      missing.map((r) => ({ user_id: userId, key: r.key, name: r.name, enabled: true }))
    );
    if (error) throw new Error(`routines-seed: ${error.message}`);
  }
  const { data, error } = await supabase
    .from("routines")
    .select("key, name, enabled")
    .eq("user_id", userId)
    .order("key");
  if (error) throw new Error(`routines-read: ${error.message}`);
  return (data ?? []).map((r) => ({ key: r.key, name: r.name, enabled: r.enabled }));
}

export async function setRoutineEnabled(
  userId: string,
  key: string,
  enabled: boolean
): Promise<RoutineRow> {
  if (!ROUTINE_REGISTRY.some((r) => r.key === key)) throw new Error("unknown routine");
  const supabase = createServerSupabase();
  // Ensure the row exists first (seed-on-toggle for users predating the seed).
  await listRoutines(userId);
  const { data, error } = await supabase
    .from("routines")
    .update({ enabled })
    .eq("user_id", userId)
    .eq("key", key)
    .select("key, name, enabled")
    .maybeSingle();
  if (error) throw new Error(`routines-write: ${error.message}`);
  if (!data) throw new Error("routine not found");
  return { key: data.key, name: data.name, enabled: data.enabled };
}

async function upsertFindings(
  userId: string,
  findings: RoutineFinding[]
): Promise<number> {
  if (findings.length === 0) return 0;
  const supabase = createServerSupabase();
  const keys = [...new Set(findings.map((f) => f.routine_key))];
  const { data: open } = await supabase
    .from("routine_findings")
    .select("id, routine_key, dedupe_hash")
    .eq("user_id", userId)
    .eq("status", "open")
    .in("routine_key", keys);
  const openByHash = new Map(
    (open ?? []).map((r) => [`${r.routine_key}:${r.dedupe_hash}`, r.id])
  );

  let created = 0;
  for (const f of findings) {
    const existingId = openByHash.get(`${f.routine_key}:${f.dedupe_hash}`);
    if (existingId) {
      // Refresh a still-open finding; never touch resolved/dismissed/snoozed.
      const { error } = await supabase
        .from("routine_findings")
        .update({
          title: f.title,
          detail: f.detail,
          impact_cents: f.impact_cents,
          evidence: f.evidence,
        })
        .eq("id", existingId)
        .eq("user_id", userId);
      if (error) throw new Error(`findings-refresh: ${error.message}`);
      continue;
    }
    const { error } = await supabase.from("routine_findings").insert({
      user_id: userId,
      routine_key: f.routine_key,
      kind: f.kind,
      title: f.title,
      detail: f.detail,
      impact_cents: f.impact_cents,
      evidence: f.evidence,
      dedupe_hash: f.dedupe_hash,
    });
    if (error) {
      // Lost race with a concurrent run — the unique constraint did its job.
      if (error.code !== "23505") throw new Error(`findings-write: ${error.message}`);
      continue;
    }
    created++;
  }
  return created;
}

export interface RunSummary {
  ran_at: string;
  routines: Array<{ key: string; checked: number; new_findings: number }>;
}

/**
 * Run every enabled routine against the user's ledger. Idempotent.
 * Also processes pending expected refunds (match -> matched, shortfall ->
 * finding + status flip so it is only surfaced once).
 */
export async function runRoutines(viewer: Viewer): Promise<RunSummary> {
  const supabase = createServerSupabase();
  const routines = await listRoutines(viewer.userId);
  const enabled = new Set(routines.filter((r) => r.enabled).map((r) => r.key));

  const ledger = await loadLedger(viewer);
  const txns = ledger.txns.map(toRoutineTxn);
  const nowISO = new Date().toISOString().slice(0, 10);
  const ranAt = new Date().toISOString();

  const perRoutine = new Map<RoutineKey, RoutineFinding[]>();
  const put = (key: RoutineKey, fs: RoutineFinding[]) => {
    const arr = perRoutine.get(key) ?? [];
    arr.push(...fs);
    perRoutine.set(key, arr);
  };

  if (enabled.has("price_hike")) put("price_hike", detectPriceHikes(txns));
  if (enabled.has("duplicate_charge")) put("duplicate_charge", detectDuplicates(txns));
  if (enabled.has("fee_sweep")) put("fee_sweep", detectFeeSweep(txns, nowISO));
  if (enabled.has("overlap")) put("overlap", detectOverlap(txns));
  if (enabled.has("trial_watch")) put("trial_watch", detectPossibleTrials(txns));

  if (enabled.has("refund_watch")) {
    const { data: pending } = await supabase
      .from("expected_refunds")
      .select("id, merchant, amount_cents, expected_date")
      .eq("user_id", viewer.userId)
      .eq("status", "pending");
    const expected: ExpectedRefund[] = (pending ?? []).map((r) => ({
      id: r.id,
      merchant: r.merchant,
      amount_cents: r.amount_cents,
      expected_date: r.expected_date.slice(0, 10),
    }));
    const { matched, shortfalls, received } = matchRefunds(expected, txns);
    for (const m of matched) {
      await supabase
        .from("expected_refunds")
        .update({ status: "matched", matched_txn_id: m.txn.id })
        .eq("id", m.expected.id)
        .eq("user_id", viewer.userId);
    }
    for (const s of shortfalls) {
      const refundId = s.evidence.expected_refund_id as string;
      await supabase
        .from("expected_refunds")
        .update({ status: "shortfall" })
        .eq("id", refundId)
        .eq("user_id", viewer.userId);
    }
    put("refund_watch", [...shortfalls, ...received]);
  }

  const summary: RunSummary = { ran_at: ranAt, routines: [] };
  for (const r of routines) {
    const findings = perRoutine.get(r.key as RoutineKey) ?? [];
    let created = 0;
    if (r.enabled && findings.length > 0) {
      created = await upsertFindings(viewer.userId, findings);
    }
    if (r.enabled) {
      await supabase.from("routine_runs").insert({
        user_id: viewer.userId,
        routine_key: r.key,
        ran_at: ranAt,
        checked_count: txns.length,
        findings_count: created,
        note: `Scanned ${txns.length} ledger transactions.`,
      });
    }
    summary.routines.push({ key: r.key, checked: txns.length, new_findings: created });
  }
  return summary;
}

/** Open findings, ranked by money impact then recency. Snoozed items return when due. */
export async function listOpenFindings(userId: string): Promise<FindingRow[]> {
  const supabase = createServerSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("routine_findings")
    .select("id, routine_key, kind, title, detail, impact_cents, evidence, status, snoozed_until, created_at")
    .eq("user_id", userId)
    .or(`status.eq.open,and(status.eq.snoozed,snoozed_until.lte.${today})`)
    .order("impact_cents", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`findings-read: ${error.message}`);
  return (data ?? []) as FindingRow[];
}

export type FindingAction = "resolve" | "dismiss" | "snooze";

export async function actOnFinding(
  userId: string,
  findingId: string,
  action: FindingAction,
  snoozeDays = 7
): Promise<FindingRow> {
  const supabase = createServerSupabase();
  const { data: row, error: readError } = await supabase
    .from("routine_findings")
    .select("id, routine_key, kind, title, detail, impact_cents, evidence, status, snoozed_until, created_at")
    .eq("id", findingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw new Error(`findings-read: ${readError.message}`);
  if (!row) throw new Error("finding not found");

  const days = Math.min(90, Math.max(1, Math.floor(snoozeDays) || 7));
  const patch: Record<string, unknown> =
    action === "resolve"
      ? { status: "resolved", resolved_at: new Date().toISOString(), snoozed_until: null }
      : action === "dismiss"
        ? { status: "dismissed", resolved_at: new Date().toISOString(), snoozed_until: null }
        : {
            status: "snoozed",
            resolved_at: null,
            snoozed_until: new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10),
          };
  const { data: updated, error } = await supabase
    .from("routine_findings")
    .update(patch)
    .eq("id", findingId)
    .eq("user_id", userId)
    .select("id, routine_key, kind, title, detail, impact_cents, evidence, status, snoozed_until, created_at")
    .maybeSingle();
  if (error) throw new Error(`findings-write: ${error.message}`);
  if (!updated) throw new Error("finding not found");

  // Pilot signal: the user engaged with a routine finding. Buckets only.
  logPilotEvent(userId, "recurring_item_reviewed", {
    routine: String(row.routine_key),
    outcome: action,
  }).catch(() => {});
  return updated as FindingRow;
}

export async function listRuns(userId: string, limit = 50): Promise<RunRow[]> {
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("routine_runs")
    .select("id, routine_key, ran_at, checked_count, findings_count, note")
    .eq("user_id", userId)
    .order("ran_at", { ascending: false })
    .limit(Math.min(100, Math.max(1, limit)));
  if (error) throw new Error(`runs-read: ${error.message}`);
  return (data ?? []) as RunRow[];
}

export async function listExpectedRefunds(userId: string): Promise<ExpectedRefundRow[]> {
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("expected_refunds")
    .select("id, merchant, amount_cents, expected_date, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`refunds-read: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    merchant: r.merchant,
    amount_cents: r.amount_cents,
    expected_date: r.expected_date.slice(0, 10),
    status: r.status as ExpectedRefundRow["status"],
    created_at: r.created_at,
  }));
}

export async function createExpectedRefund(
  userId: string,
  input: { merchant: string; amount_cents: number; expected_date: string }
): Promise<ExpectedRefundRow> {
  const merchant = input.merchant.trim();
  if (merchant.length === 0 || merchant.length > 120) throw new Error("invalid merchant");
  if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0 || input.amount_cents > 100_000_000) {
    throw new Error("invalid amount");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expected_date) || Number.isNaN(Date.parse(input.expected_date))) {
    throw new Error("invalid date");
  }
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("expected_refunds")
    .insert({
      user_id: userId,
      merchant,
      amount_cents: input.amount_cents,
      expected_date: input.expected_date,
    })
    .select("id, merchant, amount_cents, expected_date, status, created_at")
    .single();
  if (error) throw new Error(`refunds-write: ${error.message}`);
  return {
    id: data.id,
    merchant: data.merchant,
    amount_cents: data.amount_cents,
    expected_date: data.expected_date.slice(0, 10),
    status: data.status,
    created_at: data.created_at,
  };
}

export async function deleteExpectedRefund(userId: string, id: string): Promise<void> {
  const supabase = createServerSupabase();
  const { error, count } = await supabase
    .from("expected_refunds")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new Error(`refunds-write: ${error.message}`);
  if ((count ?? 0) === 0) throw new Error("refund not found");
}
