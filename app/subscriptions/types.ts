/**
 * Subscription Action Center — shared UI types and presentation helpers.
 *
 * Shapes mirror the Wave 3 API contracts. Anything the server may omit is
 * optional here; rendering stays defensive so a contract drift degrades to a
 * missing row, never a crash.
 */
import { formatUSD } from "@/lib/fire";
import type { ActionState } from "@/lib/subscriptions";

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export interface SubscriptionItem {
  id: string;
  merchant_normalized: string;
  merchant_key: string | null;
  display_name: string | null;
  route_type: string | null;
  registry_confidence: string | null;
  billing_channel: string | null;
  last_amount_cents: number | null;
  amount_cents_avg: number | null;
  cadence: string;
  monthly_cents: number;
  last_charge_date: string | null;
  next_charge_date: string | null;
  next_expected_at: string | null;
  price_changed: boolean;
  prev_amount_cents: number | null;
  lifecycle_state: string;
  user_correction: string | null;
}

export interface AmountModel {
  rule?: string;
  amount_cents?: number;
  min_cents?: number;
  max_cents?: number;
}

export interface SeriesRow {
  id: string;
  merchant_normalized: string;
  merchant_key: string | null;
  billing_channel: string | null;
  lifecycle_state: string;
  user_correction: string | null;
  cadence: string;
  amount_cents_avg: number | null;
  last_amount_cents: number | null;
  prev_amount_cents: number | null;
  price_changed: boolean;
  next_charge_date: string | null;
  next_expected_at: string | null;
  amount_model: AmountModel | null;
  confidence: number | null;
  dismissed: boolean;
}

export interface RegistryInfo {
  merchant_key: string;
  display_name: string;
  route_type: string;
  confidence: string;
  version: number;
  source_checked_at: string | null;
}

export interface ActionRequestSummary {
  id: string;
  action_type: string;
  route_type: string;
  status: string;
  registry_version: number | null;
  verification_level: string | null;
  opened_at: string | null;
  created_at: string;
}

export interface ActionRequestRow extends ActionRequestSummary {
  series_id: string | null;
  merchant_key: string | null;
  submitted_at: string | null;
  completed_at: string | null;
}

export interface SubscriptionDetailData {
  series: SeriesRow;
  registry: RegistryInfo | null;
  open_requests: ActionRequestSummary[];
  latest_savings: SavingsRow | null;
  /** NOTE: the API returns this as `eligibility` (not `cancel_eligible`). */
  eligibility: { eligible: boolean; reason?: string; copy?: string };
}

export interface ActionEvent {
  id: string;
  request_id: string;
  event_type: string;
  actor_type: string;
  actor_ref?: string | null;
  payload?: Record<string, unknown> | null;
  occurred_at: string;
}

export interface SavingsRow {
  id: string;
  monthly_cents: number;
  annual_cents: number;
  one_time_cents: number;
  modeled_months: number | null;
  verification: "reported" | "likely" | "confirmed";
  basis?: { note?: string } | null;
  created_at: string;
}

export interface PreviewResult {
  eligible: boolean;
  state?: string;
  copy?: string;
  merchant_key?: string;
  display_name?: string;
  route_type?: string;
  steps?: unknown;
  destination_host?: string | null;
  requirements?: unknown;
  warnings?: unknown;
  data_shared?: string[] | null;
  fee_cents: number;
  fee_note?: string;
  source_checked_at?: string | null;
  confidence?: string;
  registry_version?: number;
  next_status_copy?: string;
  reason?: string;
}

export interface HandoffResult {
  handoff: {
    scenario_monthly_investment_cents: number;
    temp_only: boolean;
    number_impact_available: boolean;
    baseline_version: string;
    calc_version: string;
    note: string;
  };
  scenario: { monthly_investment_cents: number; temp_only: boolean };
  baseline_note: string | null;
}

export interface ActionDetailData {
  request: ActionRequestRow;
  events: ActionEvent[];
  latest_savings: SavingsRow | null;
  next_step_copy: string | null;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Guarded money formatting — the API contract promises integer cents, but we never crash on drift. */
export function money(cents: number | null | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  return formatUSD(Math.round(cents));
}

/** "Netflix" for display_name ?? merchant_normalized. */
export function displayNameOf(item: {
  display_name: string | null;
  merchant_normalized: string;
}): string {
  return item.display_name?.trim() || item.merchant_normalized || "Unknown merchant";
}

/** Cadence -> per-period suffix for "~$17.99/mo" style labels. */
export function cadencePer(cadence: string | null | undefined): string {
  switch (cadence) {
    case "weekly":
      return "/wk";
    case "quarterly":
      return "/quarter";
    case "annual":
      return "/yr";
    case "monthly":
    default:
      return "/mo";
  }
}

export function cadenceLabel(cadence: string | null | undefined): string {
  switch (cadence) {
    case "weekly":
      return "Weekly";
    case "quarterly":
      return "Quarterly";
    case "annual":
      return "Annual";
    case "monthly":
      return "Monthly";
    default:
      return "Recurring";
  }
}

/** "2026-09-24" or ISO timestamp -> "Sep 24, 2026". Returns null when unparseable. */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function billingChannelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case "direct":
      return "Billed directly by the merchant";
    case "apple":
      return "Billed via Apple App Store";
    case "google":
      return "Billed via Google Play";
    default:
      return "Billing channel unknown";
  }
}

/** Verbatim user-facing status copy; falls back to a prettified state name. */
export function statusCopyOf(
  status: string,
  STATUS_COPY: Record<ActionState, string>
): string {
  return (STATUS_COPY as Record<string, string>)[status] ?? status.replace(/_/g, " ");
}

/** Coerce unknown registry JSON into a string list (requirements/warnings/steps). */
export function asStringList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (Array.isArray(v)) {
    return v
      .map((x) =>
        typeof x === "string"
          ? x
          : x != null && typeof x === "object"
            ? Object.values(x as Record<string, unknown>)
                .filter((y) => typeof y === "string")
                .join(" — ")
            : ""
      )
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (v != null && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) =>
        typeof val === "string" ? `${k}: ${val}` : val != null ? `${k}: ${String(val)}` : k
      )
      .filter(Boolean);
  }
  return [];
}

export const EVENT_LABELS: Record<string, string> = {
  draft_created: "Action draft created",
  route_launched: "Cancellation route opened",
  action_started: "Action started",
  outcome_reported: "Outcome reported",
  marked_not_subscription: "Marked not a subscription",
  request_withdrawn: "Request withdrawn",
  route_reported_stale: "Route reported as outdated",
};

export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
}

export const VERIFICATION_LABEL: Record<string, string> = {
  reported: "Reported",
  likely: "Likely",
  confirmed: "Confirmed",
};
