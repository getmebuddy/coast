/**
 * Shared helpers for the Subscription Action Center API routes.
 *
 * Conventions (repo-wide):
 *  - Money: integer cents. Dates: YYYY-MM-DD.
 *  - Response envelope: { ok: true, data } / { ok: false, error, message }.
 *  - Auth: every route loads the session user via getAuth(); 401 when absent.
 *  - Every mutating route inserts its action_events row BEFORE updating the
 *    request status (spec §8). On event-insert failure the route returns 500
 *    without having changed the status.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  matchMerchant,
  routeEligible,
  type SubscriptionCadence,
} from "@/lib/subscriptions";

/** { ok: true, data } envelope. */
export function ok(data: unknown, status = 200) {
  return NextResponse.json({ ok: true, data }, { status });
}

/** { ok: false, error, message } envelope. */
export function fail(error: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error, message }, { status });
}

/** Session-scoped Supabase client + authenticated user. 401 when signed out. */
export async function getAuth() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Safely parse a JSON body; returns a 400 response on invalid JSON. */
export async function readJsonBody(req: Request): Promise<{
  body: any;
  error: ReturnType<typeof fail> | null;
}> {
  try {
    return { body: await req.json(), error: null };
  } catch {
    return {
      body: null,
      error: fail("invalid_json", "Request body must be valid JSON.", 400),
    };
  }
}

// ---------------------------------------------------------------------------
// Route signing (spec §9)
// ---------------------------------------------------------------------------

/**
 * Secret for signing route tokens. Prefers an explicit ACTION_ROUTE_SECRET;
 * falls back to a SHA-256 of the service-role key so a deployment without the
 * explicit secret still signs with a deployment-unique value.
 */
export const ROUTE_SECRET =
  process.env.ACTION_ROUTE_SECRET ??
  createHash("sha256")
    .update(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "")
    .digest("hex");

/** False when neither ACTION_ROUTE_SECRET nor SUPABASE_SERVICE_ROLE_KEY is set. */
export const ROUTE_SIGNING_CONFIGURED =
  Boolean(process.env.ACTION_ROUTE_SECRET) ||
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Cadence + status helpers
// ---------------------------------------------------------------------------

/** Map the detector's cadence values onto the Action Center's cadence type. */
export function toSubscriptionCadence(cadence: string): SubscriptionCadence {
  if (
    cadence === "weekly" ||
    cadence === "monthly" ||
    cadence === "quarterly" ||
    cadence === "annual"
  ) {
    return cadence;
  }
  return "monthly";
}

/**
 * Request statuses that count as "open" for the one-open-request-per-series
 * rule (spec FR-10): every state that is not a terminal outcome, withdrawn,
 * or failed.
 */
export const OPEN_REQUEST_STATUSES = [
  "identified",
  "draft",
  "action_started",
  "needs_you",
  "authorized",
  "submitted",
  "unsupported",
  "reopened",
] as const;

/** Hostname only from a registry destination_ref; never the full URL. */
export function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Bucketed monthly savings for analytics — never the exact figure. */
export function savingsBucket(monthlyCents: number): string {
  if (monthlyCents <= 0) return "none";
  if (monthlyCents < 1000) return "under-10";
  if (monthlyCents < 2500) return "10-25";
  if (monthlyCents < 5000) return "25-50";
  return "50-plus";
}

// ---------------------------------------------------------------------------
// action_events (append-only)
// ---------------------------------------------------------------------------

export interface AppendEventArgs {
  request_id: string;
  user_id: string;
  event_type: string;
  actor_type: "user" | "system" | "operator" | "partner";
  payload?: Record<string, unknown>;
}

/**
 * Append an action_events row. Returns the insert error (null on success).
 * Callers check this BEFORE updating the request status.
 */
export async function appendEvent(
  supabase: ReturnType<typeof createServerSupabase>,
  args: AppendEventArgs
) {
  const { error } = await supabase.from("action_events").insert({
    request_id: args.request_id,
    user_id: args.user_id,
    event_type: args.event_type,
    actor_type: args.actor_type,
    payload: args.payload ?? {},
  });
  return error;
}

// ---------------------------------------------------------------------------
// Registry route resolution (shared by preview, create, detail, launch)
// ---------------------------------------------------------------------------

export interface RegistryRow {
  merchant_key: string;
  display_name: string;
  aliases: string[];
  billing_channels: string[];
  supported_actions: string[];
  route_type: "direct" | "guide" | "assisted";
  destination_ref: string | null;
  guide_steps: unknown;
  requirements: unknown;
  warnings: unknown;
  source_checked_at: string | null;
  confidence: "high" | "medium" | "low";
  version: number;
  active: boolean;
  failure_count_7d: number;
}

export interface ResolvedRoute {
  matched: boolean;
  record: RegistryRow | null;
  /** Route kind for routeEligible: 'direct' when the record is direct, else 'guided'. */
  kind: "direct" | "guided";
  eligibility: { ok: boolean; reason?: string } | null;
}

/**
 * Resolve a series to its registry capability record. A pinned
 * series.merchant_key wins (stable join key); otherwise exact alias matching
 * via matchMerchant. Unmatched merchants stay honestly unsupported (FR-05/§4):
 * no guessed routes, ever.
 */
export async function resolveRegistryRoute(
  supabase: ReturnType<typeof createServerSupabase>,
  series: { merchant_normalized: string; merchant_key: string | null }
): Promise<ResolvedRoute> {
  const noMatch: ResolvedRoute = {
    matched: false,
    record: null,
    kind: "guided",
    eligibility: null,
  };

  let record: RegistryRow | null = null;
  if (series.merchant_key) {
    const { data } = await supabase
      .from("merchant_registry")
      .select("*")
      .eq("merchant_key", series.merchant_key)
      .maybeSingle();
    record = (data as RegistryRow | null) ?? null;
  }

  if (!record) {
    const { data: aliasRows } = await supabase
      .from("merchant_registry")
      .select("merchant_key, aliases");
    const match = matchMerchant(
      series.merchant_normalized,
      ((aliasRows ?? []) as Array<{ merchant_key: string; aliases: string[] }>).map(
        (r) => ({ merchant_key: r.merchant_key, aliases: r.aliases ?? [] })
      )
    );
    if (!match) return noMatch;
    const { data } = await supabase
      .from("merchant_registry")
      .select("*")
      .eq("merchant_key", match.merchant_key)
      .maybeSingle();
    record = (data as RegistryRow | null) ?? null;
    if (!record) return noMatch;
  }

  const kind: "direct" | "guided" =
    record.route_type === "direct" ? "direct" : "guided";
  const eligibility = routeEligible(
    {
      active: record.active,
      confidence: record.confidence,
      source_checked_at: record.source_checked_at ?? "",
      failure_count_7d: record.failure_count_7d ?? 0,
      supported_actions: record.supported_actions ?? [],
    },
    kind,
    new Date()
  );
  return { matched: true, record, kind, eligibility };
}

/**
 * Decode a route token's payload WITHOUT verifying it — used only to find
 * the request_id so the server can load the CURRENT registry record and
 * verify the token against today's allowlist (spec §9).
 */
export function decodeRouteTokenPayload(token: string): {
  request_id?: string;
  destination?: string;
  registry_version?: number;
  exp_epoch?: number;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad =
      padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return JSON.parse(Buffer.from(padded + pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
