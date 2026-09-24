/**
 * POST /api/actions/[id]/outcome — user-reported result (spec §8, FR-23).
 *
 * Maps the outcome onto the state machine, records optional private evidence
 * metadata (no bytes here), computes savings from the outcome (spec FR-25 —
 * refunds are never annualized; unknown downgrade amounts are not guessed),
 * updates the series lifecycle, and appends 'outcome_reported' (or
 * 'marked_not_subscription') BEFORE the status update.
 *
 * Verification levels stay distinct: a user attestation produces Reported
 * complete only. Reported savings may be explored but are labeled unverified.
 */
import {
  appendEvent,
  fail,
  getAuth,
  ok,
  readJsonBody,
  toSubscriptionCadence,
} from "@/app/api/_lib/subscription-actions";
import { trackActionEvent } from "@/lib/analytics";
import {
  assertTransition,
  savingsOutcome,
  type ActionState,
} from "@/lib/subscriptions";

const OUTCOMES = [
  "cancelled",
  "paused",
  "downgraded",
  "kept",
  "not_a_subscription",
] as const;
const EVIDENCE_KINDS = ["screenshot", "structured", "email_ref"];

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { body, error: jsonError } = await readJsonBody(req);
  if (jsonError) return jsonError;
  const { outcome, evidence, prior_amount_cents, new_amount_cents } = body ?? {};

  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    return fail(
      "invalid_outcome",
      "outcome must be one of cancelled, paused, downgraded, kept, not_a_subscription.",
      400
    );
  }
  if (evidence !== undefined && evidence !== null) {
    if (typeof evidence !== "object" || !EVIDENCE_KINDS.includes(evidence.kind)) {
      return fail(
        "invalid_evidence",
        "evidence.kind must be screenshot, structured, or email_ref.",
        400
      );
    }
    if (
      evidence.description !== undefined &&
      typeof evidence.description !== "string"
    ) {
      return fail(
        "invalid_evidence",
        "evidence.description must be a string.",
        400
      );
    }
    if (
      evidence.structured_value !== undefined &&
      typeof evidence.structured_value !== "string"
    ) {
      return fail(
        "invalid_evidence",
        "evidence.structured_value must be a string.",
        400
      );
    }
  }
  if (outcome === "downgraded") {
    const amountsGiven =
      prior_amount_cents !== undefined || new_amount_cents !== undefined;
    if (amountsGiven) {
      if (!isPositiveInt(prior_amount_cents) || !isPositiveInt(new_amount_cents)) {
        return fail(
          "invalid_amounts",
          "prior_amount_cents and new_amount_cents must be positive integer cents.",
          400
        );
      }
      if (new_amount_cents >= prior_amount_cents) {
        return fail(
          "invalid_amounts",
          "new_amount_cents must be lower than prior_amount_cents for a downgrade.",
          400
        );
      }
    }
  }

  const { data: request } = await supabase
    .from("action_requests")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!request) return fail("not_found", "Action request not found.", 404);

  const { data: series } = request.series_id
    ? await supabase
        .from("recurring")
        .select("id, lifecycle_state, cadence, last_amount_cents")
        .eq("id", request.series_id)
        .eq("user_id", user.id)
        .maybeSingle()
    : { data: null };
  const cadence = toSubscriptionCadence(series?.cadence ?? "monthly");

  let nextStatus: string;
  let eventType = "outcome_reported";
  let seriesPatch: Record<string, unknown> | null = null;
  let savingsInsert: Record<string, unknown> | null = null;

  if (outcome === "kept") {
    // Task mapping: kept → status 'kept'. (The domain machine lists kept only
    // from 'identified'; the explicit outcome mapping here applies from any
    // in-flight state, with the decision recorded on the timeline first.)
    nextStatus = "kept";
    if (series) seriesPatch = { lifecycle_state: "kept" };
  } else if (outcome === "not_a_subscription") {
    try {
      assertTransition(request.status as ActionState, "withdrawn");
    } catch (e) {
      return fail(
        "invalid_transition",
        e instanceof Error ? e.message : "This request cannot be withdrawn.",
        409
      );
    }
    nextStatus = "withdrawn";
    eventType = "marked_not_subscription";
    if (series) {
      seriesPatch = { user_correction: "not_subscription", lifecycle_state: "ended" };
    }
  } else {
    // cancelled / paused / downgraded → Reported complete (user attestation;
    // never confirmed without merchant/partner/ledger evidence).
    if (request.status === "draft") {
      // The user acted without a tracked launch (e.g. followed a guide).
      // Record the implied start honestly before the outcome — the report
      // itself is the evidence that the action began.
      const startError = await appendEvent(supabase, {
        request_id: request.id,
        user_id: user.id,
        event_type: "action_started",
        actor_type: "user",
        payload: { via: "outcome_reported_without_launch" },
      });
      if (startError) {
        return fail("db-write", "Could not record the action start.", 500);
      }
      const { error: startUpdateError } = await supabase
        .from("action_requests")
        .update({ status: "action_started", opened_at: new Date().toISOString() })
        .eq("id", request.id)
        .eq("user_id", user.id);
      if (startUpdateError) {
        return fail("db-write", "Could not start the action.", 500);
      }
    }
    try {
      assertTransition(
        (request.status === "draft" ? "action_started" : request.status) as ActionState,
        "reported_complete"
      );
    } catch (e) {
      return fail(
        "invalid_transition",
        e instanceof Error ? e.message : "This outcome cannot be recorded.",
        409
      );
    }
    nextStatus = "reported_complete";
    if (series) seriesPatch = { lifecycle_state: "ended" };

    if (outcome === "cancelled") {
      const s = series
        ? savingsOutcome({
            recurring_amount_cents: series.last_amount_cents,
            cadence,
            outcome: "cancelled",
            verified: false,
          })
        : null;
      savingsInsert = {
        monthly_cents: s?.monthly_cents ?? 0,
        annual_cents: s?.annual_cents ?? 0,
        one_time_cents: s?.one_time_cents ?? 0,
        modeled_months: s?.modeled_months ?? null,
        verification: "reported",
        basis: {
          outcome,
          cadence,
          calc: "sac-savings-1.0",
          ...(series ? {} : { note: "Series unavailable — savings not modeled." }),
        },
      };
    } else if (outcome === "paused") {
      savingsInsert = {
        monthly_cents: 0,
        annual_cents: 0,
        one_time_cents: 0,
        modeled_months: null,
        verification: "reported",
        basis: {
          outcome,
          note: "Paused — savings depend on the resume date and are not modeled.",
        },
      };
    } else {
      // downgraded
      if (isPositiveInt(prior_amount_cents) && isPositiveInt(new_amount_cents)) {
        const s = savingsOutcome({
          recurring_amount_cents: prior_amount_cents,
          cadence,
          outcome: "downgraded",
          prior_amount_cents,
          new_amount_cents,
          verified: false,
        });
        savingsInsert = {
          monthly_cents: s.monthly_cents,
          annual_cents: s.annual_cents,
          one_time_cents: s.one_time_cents,
          modeled_months: s.modeled_months,
          verification: "reported",
          basis: {
            outcome,
            cadence,
            prior_amount_cents,
            new_amount_cents,
            note: "User-reported plan amounts.",
          },
        };
      } else {
        // Honest zero: never guess the new plan amount.
        savingsInsert = {
          monthly_cents: 0,
          annual_cents: 0,
          one_time_cents: 0,
          modeled_months: null,
          verification: "reported",
          basis: {
            outcome,
            note: "Prior and new plan amounts unconfirmed — savings not modeled.",
          },
        };
      }
    }
  }

  // Evidence metadata only — bytes live in the private storage bucket.
  if (evidence) {
    const { error: evError } = await supabase.from("evidence_objects").insert({
      user_id: user.id,
      request_id: request.id,
      kind: evidence.kind,
      description: evidence.description ?? null,
      structured_value: evidence.structured_value ?? null,
    });
    if (evError) {
      return fail("db-write", "Could not save the evidence record.", 500);
    }
  }

  let savedSavings: any = null;
  if (savingsInsert) {
    const { data: s, error: sError } = await supabase
      .from("savings_outcomes")
      .insert({ user_id: user.id, request_id: request.id, ...savingsInsert })
      .select("*")
      .maybeSingle();
    if (sError) {
      return fail("db-write", "Could not save the savings outcome.", 500);
    }
    savedSavings = s;
  }

  // Event BEFORE the status update (spec §8).
  const eventError = await appendEvent(supabase, {
    request_id: request.id,
    user_id: user.id,
    event_type: eventType,
    actor_type: "user",
    payload: { outcome },
  });
  if (eventError) {
    return fail("db-write", "Could not record the outcome event.", 500);
  }

  const patch: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "reported_complete") {
    patch.verification_level = "reported";
    patch.completed_at = new Date().toISOString();
  }
  const { data: updated, error: updateError } = await supabase
    .from("action_requests")
    .update(patch)
    .eq("id", request.id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (updateError) {
    return fail("db-write", "Could not record the outcome.", 500);
  }

  if (seriesPatch && series) {
    const { error: seriesError } = await supabase
      .from("recurring")
      .update(seriesPatch)
      .eq("id", series.id)
      .eq("user_id", user.id);
    if (seriesError) {
      return fail("db-write", "Could not update the subscription series.", 500);
    }
  }

  trackActionEvent("action_reported", { outcome_type: outcome });
  return ok({ request: updated ?? request, savings: savedSavings });
}
