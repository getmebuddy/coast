/**
 * Analytics hooks for the What-If Planner.
 *
 * No third-party provider is wired yet, so events are validated and
 * dropped (dev-logged only). When a provider is added, this is the single
 * choke point. INVARIANT: props carry buckets and labels only — never raw
 * monetary values, balances, income, spending, targets, or contributions.
 */

export type PlannerEventName =
  | "planner_viewed"
  | "preset_selected"
  | "scenario_changed"
  | "scenario_completed"
  | "plan_save_started"
  | "plan_saved"
  | "plan_save_failed"
  | "share_started"
  | "feasibility_seen"
  | "temp_scenario_applied";

const MONEY_KEY_PATTERN = /(cents|balance|income|spending|target|contribution|portfolio)/i;

/** Props must be buckets/labels. Throws in dev if a key smells like money. */
function checkProps(props?: Record<string, string>): void {
  if (!props) return;
  for (const k of Object.keys(props)) {
    if (MONEY_KEY_PATTERN.test(k)) {
      throw new Error(`[analytics] prop "${k}" looks like a raw financial value — use a bucket`);
    }
  }
}

export function trackPlannerEvent(name: PlannerEventName, props?: Record<string, string>): void {
  checkProps(props);
  // No provider wired: dev log only. Production drops the event.
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.debug("[planner-analytics]", name, props ?? {});
  }
}

// ---------------------------------------------------------------------------
// Subscription Action Center events (spec §12). Same invariant as the
// planner: props carry buckets and labels only — NEVER exact amounts,
// merchant account refs, transaction descriptions, or evidence.
// ---------------------------------------------------------------------------

/** Core Action Center events from spec §12. */
export type ActionEventName =
  | "action_center_viewed"
  | "action_previewed"
  | "action_started"
  | "action_authorized"
  | "action_submitted"
  | "action_needs_user"
  | "action_reported"
  | "action_verified"
  | "action_reopened"
  | "planner_handoff"
  | "plan_updated";

/**
 * Server-side bucketed event log for the Action Center. checkProps throws in
 * dev if a prop key smells like a raw financial value — callers must pass
 * buckets (route_type, confidence, outcome_type, savings_bucket, …) only.
 */
export function trackActionEvent(name: ActionEventName, props?: Record<string, string>): void {
  checkProps(props);
  // No provider wired: dev log only. Production drops the event.
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.debug("[action-analytics]", name, props ?? {});
  }
}

// ---------------------------------------------------------------------------
// B2C pilot events (pilot plan §"Minimum event schema"). Persisted
// server-side to public.pilot_events via POST /api/analytics (client) or
// logPilotEvent() in lib/analytics-server.ts (route handlers).
// INVARIANT: props carry buckets and labels only — never raw monetary
// values, balances, account numbers, tokens, emails, or names. The API
// route re-validates; this throws in dev so bad call sites fail fast.
// ---------------------------------------------------------------------------

/** Events in the pilot_events check constraint (migration 006). */
export type PilotEventName =
  | "signup_completed"
  | "account_link_started"
  | "account_link_succeeded"
  | "account_link_failed"
  | "number_completed"
  | "first_insight_viewed"
  | "morning_brief_viewed"
  | "what_if_saved"
  | "recurring_item_reviewed"
  | "equity_event_added"
  | "next_action_recorded"
  | "pricing_choice_shown"
  | "pricing_plan_selected"
  | "payment_completed"
  | "data_export_requested"
  | "account_deleted";

const PILOT_EVENTS: ReadonlySet<string> = new Set<string>([
  "signup_completed",
  "account_link_started",
  "account_link_succeeded",
  "account_link_failed",
  "number_completed",
  "first_insight_viewed",
  "morning_brief_viewed",
  "what_if_saved",
  "recurring_item_reviewed",
  "equity_event_added",
  "next_action_recorded",
  "pricing_choice_shown",
  "pricing_plan_selected",
  "payment_completed",
  "data_export_requested",
  "account_deleted",
]);

/** Key denylist for pilot props — buckets/labels only, never PII or money. */
const PILOT_PROP_DENY = /(cents|balance|income|spending|target|contribution|portfolio|email|name|phone|address|token|secret|password|ssn)/i;
const PILOT_COHORT_PATTERN = /^[a-z0-9-]{1,40}$/;

/** Pure validation shared by the client helper, the API route, and tests. */
export function validatePilotEvent(
  name: string,
  props?: Record<string, string>
): { name: PilotEventName; props: Record<string, string> } {
  if (!PILOT_EVENTS.has(name)) {
    throw new Error(`[pilot-analytics] unknown event "${name}"`);
  }
  const clean: Record<string, string> = {};
  const keys = props ? Object.keys(props) : [];
  if (keys.length > 12) {
    throw new Error("[pilot-analytics] too many props (max 12)");
  }
  for (const k of keys) {
    if (PILOT_PROP_DENY.test(k)) {
      throw new Error(`[pilot-analytics] prop "${k}" looks like PII or a raw financial value — use a bucket`);
    }
    const v = props![k];
    if (typeof v !== "string" || v.length > 120) {
      throw new Error(`[pilot-analytics] prop "${k}" must be a short string label`);
    }
    clean[k] = v;
  }
  if (JSON.stringify(clean).length > 2048) {
    throw new Error("[pilot-analytics] props too large (max 2KB)");
  }
  return { name: name as PilotEventName, props: clean };
}

export function isValidPilotCohort(value: string | undefined): boolean {
  return value === undefined || PILOT_COHORT_PATTERN.test(value);
}

/**
 * Client-side pilot tracking. Fire-and-forget POST to /api/analytics —
 * never throws, never blocks UI. Auth is resolved server-side from the
 * session cookie, so the client never sends a user id.
 */
export function trackPilotEvent(name: PilotEventName, props?: Record<string, string>): void {
  try {
    validatePilotEvent(name, props);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") throw e;
    return;
  }
  if (typeof window === "undefined") return;
  try {
    fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: name, properties: props ?? {} }),
      keepalive: true,
    }).catch(() => {
      /* analytics must never break the app */
    });
  } catch {
    /* ignore */
  }
}
