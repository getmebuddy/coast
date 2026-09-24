/**
 * Subscription Action Center — pure domain library (Wave 1, task A).
 *
 * Everything in this module is a pure function: no DB, no fetch, no I/O.
 * API and UI agents build on top of these exports; the signatures below are
 * the stable contract.
 *
 * Conventions (repo-wide):
 *  - Money: integer cents (positive for costs/savings).
 *  - Dates: YYYY-MM-DD (ISO, UTC).
 *  - No emojis.
 *
 * Spec references: sections cited in doc comments as "spec §N".
 */


// ---------------------------------------------------------------------------
// Cadence handling (spec FR-04, FR-25; §13 unit tests)
// ---------------------------------------------------------------------------

/**
 * Billing cadence for a subscription series. Superset of the Cadence type in
 * lib/recurring.ts (which covers weekly/monthly/annual) with "quarterly" added
 * for the Action Center.
 */
export type SubscriptionCadence = "weekly" | "monthly" | "quarterly" | "annual";

export const SUBSCRIPTION_CADENCES: readonly SubscriptionCadence[] = [
  "weekly",
  "monthly",
  "quarterly",
  "annual",
];

/** Monthly equivalent of one charge at a cadence. Positive cents in/out. */
export function monthlyEquivalentFor(
  cadence: SubscriptionCadence,
  amountCents: number
): number {
  switch (cadence) {
    case "weekly":
      return Math.round((amountCents * 52) / 12);
    case "quarterly":
      return Math.round(amountCents / 3);
    case "annual":
      return Math.round(amountCents / 12);
    case "monthly":
      return amountCents;
  }
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
  // Clamp month-end overflow (Jan 31 + 1mo -> Feb 28/29, not Mar 3).
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Next expected charge date given the last charge date and cadence. */
export function nextExpectedDate(
  lastChargeDate: string,
  cadence: SubscriptionCadence
): string {
  switch (cadence) {
    case "weekly":
      return addDaysISO(lastChargeDate, 7);
    case "monthly":
      return addMonthsISO(lastChargeDate, 1);
    case "quarterly":
      return addMonthsISO(lastChargeDate, 3);
    case "annual":
      return addMonthsISO(lastChargeDate, 12);
  }
}

// ---------------------------------------------------------------------------
// Representative amount (spec FR-01, FR-04; §13 unit tests)
// ---------------------------------------------------------------------------

export type RepresentativeRule = "last_stable" | "median_3" | "range";

export interface RepresentativeAmount {
  /** The single representative figure. Positive cents. */
  amount_cents: number;
  rule: RepresentativeRule;
  /** Observed min/max. Always present when rule is "median_3" or "range". */
  min_cents?: number;
  max_cents?: number;
}

const STABLE_TOLERANCE = 0.01; // charges equal within 1%
const RANGE_SPREAD = 0.5; // max-min > 50% of median -> show a range, not a figure

function medianOf(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Representative amount for a series of observed charges (positive cents,
 * oldest first). Spec FR-04: never imply false precision for variable bills.
 *
 *  - All charges within 1% of the last -> "last_stable", amount = last charge.
 *  - Otherwise -> "median_3": median of the last 3 charges (or all when fewer
 *    than 3), plus observed min/max so the UI can show a range.
 *  - If the observed spread exceeds 50% of that median -> "range": the UI must
 *    display the range, not the single figure.
 */
export function representativeAmount(
  chargesCents: number[],
  opts: { stableTolerance?: number; rangeSpread?: number } = {}
): RepresentativeAmount {
  if (chargesCents.length === 0) {
    throw new Error("representativeAmount: at least one charge is required");
  }
  const tolerance = opts.stableTolerance ?? STABLE_TOLERANCE;
  const spread = opts.rangeSpread ?? RANGE_SPREAD;
  const last = chargesCents[chargesCents.length - 1];

  const stable =
    last === 0
      ? chargesCents.every((c) => c === 0)
      : chargesCents.every((c) => Math.abs(c - last) <= Math.abs(last) * tolerance);
  if (stable) return { amount_cents: last, rule: "last_stable" };

  const tail = chargesCents.slice(-3);
  const median = medianOf(tail);
  const min = Math.min(...chargesCents);
  const max = Math.max(...chargesCents);
  const rule: RepresentativeRule =
    median > 0 && max - min > median * spread ? "range" : "median_3";
  return { amount_cents: median, rule, min_cents: min, max_cents: max };
}

// ---------------------------------------------------------------------------
// Savings engine (spec FR-25, §6 savings definition; §13 unit tests)
// ---------------------------------------------------------------------------

export type SavingsOutcomeKind = "cancelled" | "downgraded" | "negotiated";

export interface SavingsOutcomeInput {
  /** Recurring amount per billing period at `cadence`. Positive cents. */
  recurring_amount_cents: number;
  cadence: SubscriptionCadence;
  outcome: SavingsOutcomeKind;
  /** Pre-change recurring amount per period. Required for downgraded/negotiated. */
  prior_amount_cents?: number;
  /** Post-change recurring amount per period. Required for downgraded/negotiated. */
  new_amount_cents?: number;
  /** One-time cash refund. Positive cents. Never annualized. */
  refund_cents?: number;
  /** Guaranteed promo/contract duration in months (negotiated). Null/undefined = unknown. */
  promo_months?: number | null;
  /** Whether the outcome is verified (merchant/partner/ledger evidence). */
  verified?: boolean;
}

export interface SavingsOutcome {
  /** Recurring savings per month. Positive cents. */
  monthly_cents: number;
  /**
   * Annualized recurring savings. Capped at the known promo duration for
   * negotiated outcomes (spec §6: never annualize a temporary discount beyond
   * its stated duration). Zero when the engine cannot model the duration.
   */
  annual_cents: number;
  /** One-time cash (refunds, credits). Never annualized. */
  one_time_cents: number;
  /**
   * Months the savings are modeled over. Null = ongoing/permanent
   * (cancelled, downgraded) or unknown-and-unmodelable (negotiated without
   * promo duration — caller must show cash only).
   */
  modeled_months: number | null;
  verified: boolean;
}

/**
 * Savings from a completed action. Spec FR-25 / §6:
 *  - Refunds are one-time cash events and are never annualized.
 *  - Negotiation savings = (prior - new) monthly, over the guaranteed
 *    promo/contract duration only. Unknown duration -> modeled_months = null
 *    and annual_cents = 0 so the caller shows cash savings without an
 *    annualized figure.
 *  - Cancelled/downgraded savings are permanent: modeled_months = null with
 *    annual_cents = monthly * 12 (distinguish from negotiated-unknown by the
 *    outcome field the caller holds).
 */
export function savingsOutcome(input: SavingsOutcomeInput): SavingsOutcome {
  const monthlyRecurring = monthlyEquivalentFor(
    input.cadence,
    input.recurring_amount_cents
  );
  const refund = Math.max(0, Math.round(input.refund_cents ?? 0));
  const verified = input.verified ?? false;

  if (input.outcome === "cancelled") {
    return {
      monthly_cents: monthlyRecurring,
      annual_cents: monthlyRecurring * 12,
      one_time_cents: refund,
      modeled_months: null,
      verified,
    };
  }

  const prior = input.prior_amount_cents ?? input.recurring_amount_cents;
  const after = input.new_amount_cents ?? input.recurring_amount_cents;
  if (input.prior_amount_cents == null || input.new_amount_cents == null) {
    throw new Error(
      `savingsOutcome: prior_amount_cents and new_amount_cents are required for "${input.outcome}"`
    );
  }
  const monthlySavings = Math.max(
    0,
    monthlyEquivalentFor(input.cadence, prior) -
      monthlyEquivalentFor(input.cadence, after)
  );

  if (input.outcome === "downgraded") {
    return {
      monthly_cents: monthlySavings,
      annual_cents: monthlySavings * 12,
      one_time_cents: refund,
      modeled_months: null,
      verified,
    };
  }

  // negotiated: duration-bounded.
  const promo = input.promo_months;
  if (promo != null && promo > 0) {
    const months = Math.floor(promo);
    return {
      monthly_cents: monthlySavings,
      annual_cents: monthlySavings * Math.min(12, months),
      one_time_cents: refund,
      modeled_months: months,
      verified,
    };
  }
  return {
    monthly_cents: monthlySavings,
    annual_cents: 0,
    one_time_cents: refund,
    modeled_months: null,
    verified,
  };
}

// ---------------------------------------------------------------------------
// State machine (spec §8; §13 unit tests)
// ---------------------------------------------------------------------------

/** The 14 canonical action-request states (spec §8). */
export type ActionState =
  | "identified"
  | "draft"
  | "action_started"
  | "needs_you"
  | "authorized"
  | "submitted"
  | "reported_complete"
  | "likely_complete"
  | "confirmed_complete"
  | "failed"
  | "unsupported"
  | "withdrawn"
  | "reopened"
  | "kept";

export const ACTION_STATES: readonly ActionState[] = [
  "identified",
  "draft",
  "action_started",
  "needs_you",
  "authorized",
  "submitted",
  "reported_complete",
  "likely_complete",
  "confirmed_complete",
  "failed",
  "unsupported",
  "withdrawn",
  "reopened",
  "kept",
];

/**
 * Allowed transitions. Key invariants (spec §8):
 *  - submitted can never jump directly to confirmed_complete — completion
 *    must flow through reported_complete / likely_complete (evidence first).
 *  - reported, likely, and confirmed remain distinct verification levels.
 *  - Failed requests keep their history; retry spawns a new request.
 *  - Reopened never deletes completed history.
 */
export const ALLOWED_TRANSITIONS: Record<ActionState, ActionState[]> = {
  identified: ["draft", "kept", "unsupported"],
  draft: ["action_started", "needs_you", "authorized", "withdrawn"],
  action_started: ["needs_you", "reported_complete", "failed", "withdrawn"],
  needs_you: ["action_started", "authorized", "reported_complete", "withdrawn"],
  authorized: ["submitted", "withdrawn"],
  submitted: ["needs_you", "failed", "reported_complete", "withdrawn"],
  reported_complete: ["likely_complete", "confirmed_complete", "reopened", "withdrawn"],
  likely_complete: ["confirmed_complete", "reopened"],
  confirmed_complete: ["reopened"],
  failed: ["draft"],
  kept: ["draft"],
  unsupported: ["draft"],
  withdrawn: ["draft"],
  reopened: ["action_started", "draft", "reported_complete"],
};

/**
 * Assert that a transition is allowed; throws on an invalid jump.
 * Also throws on unknown states (defense against bad callers).
 */
export function assertTransition(from: ActionState, to: ActionState): void {
  if (!ACTION_STATES.includes(from)) {
    throw new Error(`assertTransition: unknown from-state "${from}"`);
  }
  if (!ACTION_STATES.includes(to)) {
    throw new Error(`assertTransition: unknown to-state "${to}"`);
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(
      `assertTransition: invalid transition "${from}" -> "${to}". ` +
        `Allowed: ${ALLOWED_TRANSITIONS[from].join(", ") || "(none)"}`
    );
  }
}

/**
 * Whether the state is a completed outcome the user reached through the
 * action flow. Terminal for the action lifecycle (a new request, e.g. after
 * kept -> draft or confirmed_complete -> reopened, goes through the machine
 * again). Spec FR-23 / §14.
 */
export function isTerminalOutcome(state: ActionState): boolean {
  return (
    state === "reported_complete" ||
    state === "likely_complete" ||
    state === "confirmed_complete" ||
    state === "kept"
  );
}

// ---------------------------------------------------------------------------
// Consent (spec FR-07/FR-08, §10; §13 unit tests)
// ---------------------------------------------------------------------------

export interface ConsentRecord {
  expires_at: string; // ISO timestamp
  withdrawn_at: string | null; // ISO timestamp or null
  used_at?: string | null;
}

/**
 * Consent is valid only while it is unexpired and not withdrawn.
 * Spec FR-08: narrow, action-specific consent; FR-09: expired authorization
 * is never silently reused.
 */
export function isConsentValid(
  consent: ConsentRecord,
  now: Date
): boolean {
  if (consent.withdrawn_at != null) return false;
  const expires = Date.parse(consent.expires_at);
  if (Number.isNaN(expires)) return false;
  return expires > now.getTime();
}

/**
 * Returns the reason submission is blocked, or null when consent allows it.
 * Callers surface the returned string to the user.
 */
export function consentBlocksSubmission(
  consent: ConsentRecord,
  now: Date
): string | null {
  if (consent.withdrawn_at != null) {
    return "Consent was withdrawn; submission is blocked until new consent is captured.";
  }
  const expires = Date.parse(consent.expires_at);
  if (Number.isNaN(expires)) {
    return "Consent has no valid expiration; submission is blocked until new consent is captured.";
  }
  if (expires <= now.getTime()) {
    return "Consent expired; submission is blocked until new consent is captured.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Merchant matching (spec §4 matching rules; §13 unit tests)
// ---------------------------------------------------------------------------

export interface MerchantRegistryEntry {
  merchant_key: string;
  aliases: string[];
}

export interface MerchantMatch {
  merchant_key: string;
  match: "exact" | "suggested";
}

function normalizeKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Exact alias match against the registry. Deterministic: first registry entry
 * in order wins on ties. Case-insensitive. The merchant_key itself counts as
 * an alias (it is the canonical name).
 *
 * Pure function of (name, registry) — no user context, so matching cannot
 * cross users: two users with the same normalized name always get the same
 * registry answer.
 */
export function matchMerchant(
  normalizedName: string,
  registry: MerchantRegistryEntry[]
): { merchant_key: string; match: "exact" } | null {
  const want = normalizeKey(normalizedName);
  for (const entry of registry) {
    const candidates = [entry.merchant_key, ...entry.aliases];
    if (candidates.some((a) => normalizeKey(a) === want)) {
      return { merchant_key: entry.merchant_key, match: "exact" };
    }
  }
  return null;
}

/**
 * Fuzzy (substring) suggestion. Returns match: "suggested" — a suggested
 * merchant may help the UI, but it CANNOT power an assisted action until the
 * user confirms the identity (spec §4). Returns null when nothing resembles
 * the name. First registry entry in order wins; deterministic.
 */
export function suggestMerchant(
  normalizedName: string,
  registry: MerchantRegistryEntry[]
): { merchant_key: string; match: "suggested" } | null {
  const want = normalizeKey(normalizedName);
  if (want.length < 3) return null;
  for (const entry of registry) {
    const candidates = [entry.merchant_key, ...entry.aliases];
    if (
      candidates.some(
        (a) => normalizeKey(a).includes(want) || want.includes(normalizeKey(a))
      )
    ) {
      return { merchant_key: entry.merchant_key, match: "suggested" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry eligibility (spec §4 confidence and freshness; §13 unit tests)
// ---------------------------------------------------------------------------

export type RouteKind = "assisted" | "direct" | "guided";

export interface CapabilityRecord {
  active: boolean;
  confidence: "high" | "medium" | "low";
  source_checked_at: string; // ISO date or timestamp
  failure_count_7d: number;
  supported_actions: string[];
}

export interface Eligibility {
  ok: boolean;
  reason?: string;
}

const ASSISTED_FRESHNESS_DAYS = 90;
const GUIDED_FRESHNESS_DAYS = 180;

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 86_400_000;
}

/**
 * Route eligibility per spec §4. `action` is the route kind being launched.
 *  - inactive record (kill switch) -> not eligible
 *  - failure_count_7d >= 2 -> suppressed pending review
 *  - assisted requires high confidence AND source_checked_at within 90 days
 *  - direct/guided require source_checked_at within 180 days, else "stale"
 *    (guidance only)
 *  - low confidence -> guidance only, never assisted
 *
 * Reason strings: "inactive" | "suppressed" | "stale" | "low_confidence" |
 * "confidence".
 */
export function routeEligible(
  record: CapabilityRecord,
  action: RouteKind,
  now: Date
): Eligibility {
  if (!record.active) return { ok: false, reason: "inactive" };
  if (record.failure_count_7d >= 2) return { ok: false, reason: "suppressed" };
  const ageDays = daysSince(record.source_checked_at, now);

  if (action === "assisted") {
    if (record.confidence === "low") {
      return { ok: false, reason: "low_confidence" };
    }
    if (record.confidence !== "high") {
      return { ok: false, reason: "confidence" };
    }
    if (ageDays > ASSISTED_FRESHNESS_DAYS) {
      return { ok: false, reason: "stale" };
    }
    return { ok: true };
  }

  // direct / guided
  if (record.confidence === "low") {
    return { ok: false, reason: "low_confidence" };
  }
  if (ageDays > GUIDED_FRESHNESS_DAYS) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Possible renewal (spec FR-15, FR-26; §13 unit tests)
// ---------------------------------------------------------------------------

/**
 * Series states that represent a finished action flow. A new matching charge
 * after any of these means a possible renewal — reopen, do not accuse.
 */
export const ENDED_SERIES_STATES: readonly string[] = [
  "ended",
  "reported_complete",
  "likely_complete",
  "confirmed_complete",
];

export interface SeriesForReopen {
  lifecycle_state: string;
  last_charge_date: string; // YYYY-MM-DD
  cadence: SubscriptionCadence;
}

/**
 * True when a new matching charge arrives after an ended/reported-complete
 * series state (spec FR-15/FR-26). "Matching" is the caller's job (same
 * normalized merchant, amount plausibly matching the series); this function
 * only checks the lifecycle condition: the series is in an ended state and
 * the charge is newer than the last known charge.
 */
export function shouldReopenSeries(
  series: SeriesForReopen,
  newChargeDate: string
): boolean {
  return (
    ENDED_SERIES_STATES.includes(series.lifecycle_state) &&
    newChargeDate > series.last_charge_date
  );
}

// ---------------------------------------------------------------------------
// Planner handoff (spec §7; §13 unit tests)
// ---------------------------------------------------------------------------

export interface PlannerHandoffInput {
  savings: {
    monthly_cents: number;
    modeled_months: number | null;
    /**
     * True when the savings recur indefinitely (cancelled, downgraded) and
     * can therefore be modeled as a permanent monthly contribution. False
     * for duration-bounded or unknown-duration savings (negotiated, paused),
     * which the current planner engine cannot model as temporary cash flows.
     * Note: modeled_months is null for BOTH permanent savings and
     * unknown-duration negotiated savings, so null alone must never be
     * treated as "temporary" — that is exactly the bug this flag fixes.
     */
    permanent: boolean;
  };
  baseline: { monthly_investment_cents: number; version: string };
  calc_version: string;
}

export interface PlannerHandoff {
  /** Monthly investment the temp scenario models. Equals baseline when there is no Number impact. */
  scenario_monthly_investment_cents: number;
  /** Always true: the handoff is a temporary scenario, never a plan mutation. */
  temp_only: true;
  /** False when savings cannot be modeled as recurring (e.g. unknown promo duration). */
  number_impact_available: boolean;
  /** Pass-through of the baseline (saved plan) version. */
  baseline_version: string;
  /** Pass-through of the calculation version. */
  calc_version: string;
  note: string;
}

/**
 * Build a temporary What-If scenario input from savings (spec §7).
 *  - Never mutates the saved plan: returns a scenario input only. The caller
 *    must still require the existing "Save as plan" confirmation.
 *  - Number impact is available only for permanent savings (cancelled,
 *    downgraded): they recur indefinitely and can be modeled as a permanent
 *    monthly contribution. Duration-bounded or unknown-duration savings
 *    (negotiated, paused) are shown as cash only, because the current engine
 *    cannot model temporary cash flows. modeled_months being null does NOT
 *    imply temporary — it is null for permanent savings too.
 *  - Copy uses "could" / "under these assumptions", never "will".
 */
export function buildPlannerHandoff(input: PlannerHandoffInput): PlannerHandoff {
  const impactAvailable =
    input.savings.permanent && input.savings.monthly_cents > 0;
  const scenario =
    impactAvailable
      ? input.baseline.monthly_investment_cents + input.savings.monthly_cents
      : input.baseline.monthly_investment_cents;
  const note = impactAvailable
    ? "If you add the monthly savings to investing, your projected date could move earlier under these assumptions."
    : "Cash savings are shown without Number impact: the savings duration is temporary and the current engine cannot model temporary cash flows.";
  return {
    scenario_monthly_investment_cents: scenario,
    temp_only: true,
    number_impact_available: impactAvailable,
    baseline_version: input.baseline.version,
    calc_version: input.calc_version,
    note,
  };
}

// ---------------------------------------------------------------------------
// Status copy (spec §11; §14 interaction/content tests)
// ---------------------------------------------------------------------------

/**
 * User-facing status copy per action state. Lines marked "verbatim" come
 * straight from spec §11; others are derived in the same register and are
 * honest about what each state means (never equate action-started with
 * cancelled, never claim completion without evidence).
 */
export const STATUS_COPY: Record<ActionState, string> = {
  // verbatim, spec §11 "Detected"
  identified: "We found a recurring charge of about $17.99 per month.",
  draft: "Your action is drafted and ready to review before anything is sent.",
  // verbatim, spec §11 "Action started"
  action_started:
    "You opened the cancellation route. Tell us what happened when you are done.",
  // verbatim, spec §11 "Needs you"
  needs_you: "The merchant needs your approval before anything changes.",
  authorized:
    "You approved this request. Nothing has been sent to the merchant yet.",
  submitted:
    "Your request was submitted. We will update you when we hear back.",
  // verbatim, spec §11 "Reported complete"
  reported_complete:
    "You marked this cancelled. We'll watch the next expected billing window.",
  likely_complete:
    "The expected charge did not recur after the grace window.",
  // verbatim, spec §11 "Confirmed complete"
  confirmed_complete: "Cancellation confirmed. Your plan has not changed.",
  failed: "This route failed. You can retry or choose a different route.",
  // verbatim, spec §11 "Unsupported"
  unsupported: "We do not have a verified route for this merchant yet.",
  withdrawn: "You stopped this request before it completed.",
  // verbatim, spec §11 "Possible renewal"
  reopened:
    "A new matching charge appeared after cancellation. Review it before taking another action.",
  kept: "You chose to keep this subscription. We will still flag price increases.",
};
