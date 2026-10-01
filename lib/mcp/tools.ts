/**
 * Coast MCP tool definitions — READ-ONLY, four tools, no exceptions.
 *
 * Every handler resolves the user from the OAuth token (never from request
 * input) and queries under that identity with the service-role client,
 * filtering every query by user_id. Responses are aggregates and summaries:
 * no transaction rows, no account numbers, no merchant detail beyond
 * category names.
 *
 * Tool descriptions are factual and data-only: no advice wording
 * ("you should…"), no recommendations, no instructions to the model beyond
 * describing what the tool returns.
 */
import "server-only";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  loadBudgetMonth,
  loadSpending,
  type Viewer,
  type DbClient,
} from "@/lib/real-data-server";
export type { Viewer } from "@/lib/real-data-server";
import { listOpenFindings } from "@/lib/routines-server";
import { containsDemoProvenance, assertNoDemoProvenance, type DataEnvelope } from "@/lib/real-data";
import { targetNumberCents, projectedFire, progressPct, monthYear } from "@/lib/fire";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export type ToolResult = CallToolResult;

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function toolError(message: string, supportHint = true): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "error",
          message,
          ...(supportHint ? { hint: "If this persists, contact Coast support from the app's Settings page." } : {}),
        }),
      },
    ],
    isError: true,
  };
}

/** No-demo guard: MCP responses must never contain demo values, ever. Exported for tests. */
export function guardNoDemo(env: DataEnvelope<unknown>, surface: string): void {
  if (containsDemoProvenance(env)) {
    throw new Error(`mcp: demo provenance leaked in ${surface}`);
  }
  if (process.env.NODE_ENV !== "production") {
    assertNoDemoProvenance(env, `mcp:${surface}`);
  }
}

/** Build a Viewer for an MCP-authenticated user (token already validated). */
export async function getMcpViewer(userId: string): Promise<Viewer | null> {
  const service = createServiceSupabase();
  const { data: profile, error } = await service
    .from("profiles")
    .select("timezone, real_data_enabled")
    .eq("id", userId)
    .maybeSingle();
  if (error || !profile) return null;
  return {
    userId,
    email: null,
    timezone: typeof profile.timezone === "string" && profile.timezone ? profile.timezone : "America/Chicago",
    realDataEnabled: profile.real_data_enabled === true,
  };
}

function unavailablePayload(tool: string, asOf: string) {
  return { tool, status: "unavailable", as_of: asOf, message: "Coast data is not enabled for this account." };
}

// ---------------------------------------------------------------------------
// get_number
// ---------------------------------------------------------------------------

async function runGetNumber(viewer: Viewer): Promise<ToolResult> {
  const asOf = new Date().toISOString();
  if (!viewer.realDataEnabled) return ok(unavailablePayload("get_number", asOf));
  try {
    const service: DbClient = createServiceSupabase();
    const { data: fire, error } = await service
      .from("fire_settings")
      .select("annual_spending_cents, portfolio_cents, monthly_savings_cents, expected_return_pct, target_number_cents")
      .eq("user_id", viewer.userId)
      .maybeSingle();
    if (error) throw new Error(`fire-read: ${error.message}`);
    if (!fire) {
      return ok({
        tool: "get_number",
        status: "not_set",
        as_of: asOf,
        message: "The Number has not been set yet. It can be set in the Coast app under Number.",
      });
    }
    const target = fire.target_number_cents ?? targetNumberCents(fire.annual_spending_cents);
    const proj = projectedFire({
      portfolioCents: fire.portfolio_cents,
      monthlySavingsCents: fire.monthly_savings_cents,
      annualReturnPct: Number(fire.expected_return_pct),
      targetCents: target,
    });
    return ok({
      tool: "get_number",
      status: "ok",
      as_of: asOf,
      target_cents: target,
      progress_pct: progressPct(fire.portfolio_cents, target),
      arrival_label: proj.reachable && proj.dateISO ? monthYear(proj.dateISO) : null,
      monthly_savings_cents: fire.monthly_savings_cents,
      note: "Educational projection, not financial advice.",
    });
  } catch {
    return toolError("Could not load your Number right now.");
  }
}

// ---------------------------------------------------------------------------
// get_budget_status
// ---------------------------------------------------------------------------

async function runGetBudgetStatus(viewer: Viewer): Promise<ToolResult> {
  const asOf = new Date().toISOString();
  if (!viewer.realDataEnabled) return ok(unavailablePayload("get_budget_status", asOf));
  try {
    const service: DbClient = createServiceSupabase();
    const env = await loadBudgetMonth(viewer, new Date(), service);
    guardNoDemo(env, "get_budget_status");
    if (env.mode !== "real" && env.mode !== "partial") {
      return ok({
        tool: "get_budget_status",
        status: env.mode === "setup" ? "not_set" : env.mode,
        as_of: asOf,
        month_label: env.data.monthLabel,
        message:
          env.mode === "setup"
            ? "No budget is set for this month yet. One can be created in the Coast app under Budgets."
            : "Budget data is not available right now.",
      });
    }
    const d = env.data;
    return ok({
      tool: "get_budget_status",
      status: "ok",
      as_of: asOf,
      month_label: d.monthLabel,
      ceiling_cents: d.ceilingCents,
      spent_cents: d.spentCents,
      expected_cents: d.expectedCents,
      days_remaining: d.daysRemaining,
      per_day_cents: d.perDayCents,
      categories: d.categories.map((c) => ({
        category: c.category,
        limit_cents: c.limitCents,
        spent_cents: c.spentCents,
        txn_count: c.txnCount,
      })),
    });
  } catch {
    return toolError("Could not load your budget status right now.");
  }
}

// ---------------------------------------------------------------------------
// get_attention_list
// ---------------------------------------------------------------------------

async function runGetAttentionList(viewer: Viewer): Promise<ToolResult> {
  const asOf = new Date().toISOString();
  if (!viewer.realDataEnabled) return ok(unavailablePayload("get_attention_list", asOf));
  try {
    const service: DbClient = createServiceSupabase();
    const findings = await listOpenFindings(viewer.userId, service);
    return ok({
      tool: "get_attention_list",
      status: "ok",
      as_of: asOf,
      count: findings.length,
      items: findings.slice(0, 25).map((f) => ({
        id: f.id,
        title: f.title,
        detail: f.detail,
        impact_cents: f.impact_cents,
        deep_link: "/brief",
        created_at: f.created_at,
      })),
    });
  } catch {
    return toolError("Could not load your attention list right now.");
  }
}

// ---------------------------------------------------------------------------
// get_spending_summary
// ---------------------------------------------------------------------------

async function runGetSpendingSummary(viewer: Viewer): Promise<ToolResult> {
  const asOf = new Date().toISOString();
  if (!viewer.realDataEnabled) return ok(unavailablePayload("get_spending_summary", asOf));
  try {
    const service: DbClient = createServiceSupabase();
    const env = await loadSpending(viewer, new Date(), service);
    guardNoDemo(env, "get_spending_summary");
    if (env.mode !== "real" && env.mode !== "partial") {
      return ok({
        tool: "get_spending_summary",
        status: env.mode,
        as_of: asOf,
        message: "Spending data is not available right now.",
      });
    }
    const month = env.data.ranges.month;
    const categories = month.categories.map((c) => ({
      category: c.category,
      spent_cents: c.spendCents,
      txn_count: c.txnCount,
      // NOTE: per-transaction rows (c.top) are deliberately excluded.
    }));
    return ok({
      tool: "get_spending_summary",
      status: "ok",
      as_of: asOf,
      period_label: month.periodLabel,
      total_spent_cents: categories.reduce((s, c) => s + c.spent_cents, 0),
      categories,
    });
  } catch {
    return toolError("Could not load your spending summary right now.");
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  annotations: typeof READONLY_ANNOTATIONS;
  run: (viewer: Viewer) => Promise<ToolResult>;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "get_number",
    title: "The Number",
    description:
      "Returns your Coast Number — the savings target at which work becomes optional — with current progress: target amount in cents, progress percentage, projected arrival month, and monthly savings in cents. Figures are educational and informational, not financial advice.",
    annotations: READONLY_ANNOTATIONS,
    run: runGetNumber,
  },
  {
    name: "get_budget_status",
    title: "Budget status",
    description:
      "Returns the current budget month: spending ceiling, amount spent so far, expected pace, days remaining, and per-category totals with transaction counts. Aggregates only; no individual transactions.",
    annotations: READONLY_ANNOTATIONS,
    run: runGetBudgetStatus,
  },
  {
    name: "get_attention_list",
    title: "Attention list",
    description:
      "Lists your open Morning Brief attention items — things Coast's checks flagged for review — with title, detail, estimated impact in cents, and a deep link into the Coast app. Finding-level summaries only; no transaction rows.",
    annotations: READONLY_ANNOTATIONS,
    run: runGetAttentionList,
  },
  {
    name: "get_spending_summary",
    title: "Spending summary",
    description:
      "Returns current-month spending totals by category with transaction counts. Aggregates only; no individual transactions or merchant detail.",
    annotations: READONLY_ANNOTATIONS,
    run: runGetSpendingSummary,
  },
];
