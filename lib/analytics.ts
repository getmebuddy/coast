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
