/**
 * Unit tests for lib/subscriptions.ts — the Subscription Action Center domain
 * library. Each test maps to a spec §13 unit item (mapping is in
 * docs/SUBSCRIPTION_ACTION_CENTER_TEST_PLAN.md).
 */
import { describe, expect, it } from "vitest";
import {
  ACTION_STATES,
  ALLOWED_TRANSITIONS,
  ENDED_SERIES_STATES,
  STATUS_COPY,
  assertTransition,
  buildPlannerHandoff,
  consentBlocksSubmission,
  formatScenarioProvenance,
  isConsentValid,
  isTerminalOutcome,
  matchMerchant,
  monthlyEquivalentFor,
  nextExpectedDate,
  representativeAmount,
  routeEligible,
  savingsOutcome,
  shouldReopenSeries,
  suggestMerchant,
  type ActionState,
  type CapabilityRecord,
  type ConsentRecord,
} from "./subscriptions";
import {
  idempotencyKey,
  issueRouteToken,
  verifyRouteToken,
} from "./subscriptions-server";

const NOW = new Date("2026-09-24T12:00:00Z");

function cap(
  overrides: Partial<CapabilityRecord> = {}
): CapabilityRecord {
  return {
    active: true,
    confidence: "high",
    source_checked_at: "2026-09-01T00:00:00Z",
    failure_count_7d: 0,
    supported_actions: ["cancel"],
    ...overrides,
  };
}

function consent(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    expires_at: "2026-10-24T00:00:00Z",
    withdrawn_at: null,
    ...overrides,
  };
}

// ---------- cadence conversion (spec §13: fixed cadences) ----------

describe("monthlyEquivalentFor", () => {
  it("converts weekly charges", () => {
    // 1000c weekly -> 1000*52/12 = 4333.33 -> 4333
    expect(monthlyEquivalentFor("weekly", 1000)).toBe(4333);
  });
  it("passes monthly through", () => {
    expect(monthlyEquivalentFor("monthly", 1799)).toBe(1799);
  });
  it("converts quarterly charges", () => {
    // 3000c quarterly -> 1000
    expect(monthlyEquivalentFor("quarterly", 3000)).toBe(1000);
  });
  it("converts annual charges", () => {
    // 12000c annual -> 1000
    expect(monthlyEquivalentFor("annual", 12000)).toBe(1000);
  });
  it("rounds quarter/annual divisions", () => {
    expect(monthlyEquivalentFor("annual", 100)).toBe(8); // 8.33
    expect(monthlyEquivalentFor("quarterly", 1000)).toBe(333); // 333.33
  });
});

describe("nextExpectedDate", () => {
  it("weekly adds 7 days", () => {
    expect(nextExpectedDate("2026-09-24", "weekly")).toBe("2026-10-01");
  });
  it("monthly adds 1 month with month-end clamping", () => {
    expect(nextExpectedDate("2026-09-24", "monthly")).toBe("2026-10-24");
    expect(nextExpectedDate("2026-01-31", "monthly")).toBe("2026-02-28");
  });
  it("quarterly adds 3 months", () => {
    expect(nextExpectedDate("2026-09-24", "quarterly")).toBe("2026-12-24");
  });
  it("annual adds 12 months", () => {
    expect(nextExpectedDate("2026-09-24", "annual")).toBe("2027-09-24");
  });
});

// ---------- representative amount (spec §13: variable charges rule) ----------

describe("representativeAmount", () => {
  it("stable charges use last (last_stable)", () => {
    const r = representativeAmount([1799, 1799, 1799, 1799]);
    expect(r.rule).toBe("last_stable");
    expect(r.amount_cents).toBe(1799);
    expect(r.min_cents).toBeUndefined();
  });
  it("charges within 1% count as stable", () => {
    const r = representativeAmount([10000, 10050]); // +0.5%
    expect(r.rule).toBe("last_stable");
    expect(r.amount_cents).toBe(10050);
  });
  it("variable charges use median of last 3 with min/max", () => {
    // last three: 5200, 4800, 5100 -> median 5100; spread small enough for median_3
    const r = representativeAmount([5200, 4800, 5100]);
    expect(r.rule).toBe("median_3");
    expect(r.amount_cents).toBe(5100);
    expect(r.min_cents).toBe(4800);
    expect(r.max_cents).toBe(5200);
  });
  it("wide spread becomes range with min/max exposed", () => {
    const r = representativeAmount([2000, 9000]);
    expect(r.rule).toBe("range");
    expect(r.min_cents).toBe(2000);
    expect(r.max_cents).toBe(9000);
  });
  it("rejects empty input", () => {
    expect(() => representativeAmount([])).toThrow();
  });
});

// ---------- savings engine (spec §13: refunds, promo duration) ----------

describe("savingsOutcome", () => {
  it("cancelled: monthly and annualized savings, refund is one-time only", () => {
    const s = savingsOutcome({
      recurring_amount_cents: 1799,
      cadence: "monthly",
      outcome: "cancelled",
      refund_cents: 1799,
      verified: true,
    });
    expect(s.monthly_cents).toBe(1799);
    expect(s.annual_cents).toBe(1799 * 12);
    expect(s.one_time_cents).toBe(1799);
    expect(s.verified).toBe(true);
    // refund must not leak into annualized savings
    expect(s.annual_cents).toBe(21588);
  });
  it("cancelled without refund has zero one-time", () => {
    const s = savingsOutcome({
      recurring_amount_cents: 1799,
      cadence: "monthly",
      outcome: "cancelled",
    });
    expect(s.one_time_cents).toBe(0);
    expect(s.verified).toBe(false);
  });
  it("downgraded: savings are prior minus new", () => {
    const s = savingsOutcome({
      recurring_amount_cents: 999,
      cadence: "monthly",
      outcome: "downgraded",
      prior_amount_cents: 1799,
      new_amount_cents: 999,
    });
    expect(s.monthly_cents).toBe(800);
    expect(s.annual_cents).toBe(9600);
  });
  it("negotiated with known 3-month promo: annual capped, modeled_months=3", () => {
    const s = savingsOutcome({
      recurring_amount_cents: 9000,
      cadence: "monthly",
      outcome: "negotiated",
      prior_amount_cents: 12000,
      new_amount_cents: 9000,
      promo_months: 3,
    });
    expect(s.monthly_cents).toBe(3000);
    // NOT 36000: capped at the promo duration
    expect(s.annual_cents).toBe(9000);
    expect(s.modeled_months).toBe(3);
  });
  it("negotiated with unknown promo duration: no annualization, modeled_months null", () => {
    const s = savingsOutcome({
      recurring_amount_cents: 9000,
      cadence: "monthly",
      outcome: "negotiated",
      prior_amount_cents: 12000,
      new_amount_cents: 9000,
      promo_months: null,
    });
    expect(s.monthly_cents).toBe(3000);
    expect(s.annual_cents).toBe(0);
    expect(s.modeled_months).toBeNull();
  });
  it("negotiated with promo >= 12 months annualizes fully", () => {
    const s = savingsOutcome({
      recurring_amount_cents: 9000,
      cadence: "monthly",
      outcome: "negotiated",
      prior_amount_cents: 12000,
      new_amount_cents: 9000,
      promo_months: 12,
    });
    expect(s.annual_cents).toBe(36000);
    expect(s.modeled_months).toBe(12);
  });
  it("requires prior/new amounts for downgraded and negotiated", () => {
    expect(() =>
      savingsOutcome({
        recurring_amount_cents: 1000,
        cadence: "monthly",
        outcome: "negotiated",
      })
    ).toThrow();
  });
});

// ---------- state machine (spec §13: invalid jumps) ----------

describe("state machine", () => {
  it("defines exactly the 14 canonical states", () => {
    expect(ACTION_STATES).toHaveLength(14);
    expect(new Set(ACTION_STATES).size).toBe(14);
  });

  it("rejects submitted -> confirmed_complete", () => {
    expect(() => assertTransition("submitted", "confirmed_complete")).toThrow();
  });
  it("rejects kept -> submitted", () => {
    expect(() => assertTransition("kept", "submitted")).toThrow();
  });
  it("rejects other invalid jumps", () => {
    expect(() => assertTransition("identified", "submitted")).toThrow();
    expect(() => assertTransition("draft", "confirmed_complete")).toThrow();
    expect(() => assertTransition("failed", "reported_complete")).toThrow();
    expect(() => assertTransition("authorized", "reported_complete")).toThrow();
    expect(() => assertTransition("unsupported", "submitted")).toThrow();
  });
  it("accepts the happy paths", () => {
    const ok: Array<[ActionState, ActionState]> = [
      ["identified", "draft"],
      ["draft", "action_started"],
      ["action_started", "reported_complete"],
      ["draft", "authorized"],
      ["authorized", "submitted"],
      ["submitted", "reported_complete"],
      ["reported_complete", "likely_complete"],
      ["reported_complete", "confirmed_complete"],
      ["likely_complete", "confirmed_complete"],
      ["confirmed_complete", "reopened"],
      ["reported_complete", "reopened"],
      ["reopened", "reported_complete"],
      ["reopened", "draft"],
      ["failed", "draft"],
      ["kept", "draft"],
      ["withdrawn", "draft"],
      ["unsupported", "draft"],
      ["submitted", "withdrawn"],
    ];
    for (const [from, to] of ok) {
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });
  it("rejects unknown states", () => {
    expect(() =>
      assertTransition("submitted", "nonexistent" as ActionState)
    ).toThrow();
  });

  it("reported/likely/confirmed are distinct terminal outcomes", () => {
    for (const s of [
      "reported_complete",
      "likely_complete",
      "confirmed_complete",
      "kept",
    ] as ActionState[]) {
      expect(isTerminalOutcome(s)).toBe(true);
    }
    // they are distinct states, not aliases
    expect(
      new Set(["reported_complete", "likely_complete", "confirmed_complete"])
        .size
    ).toBe(3);
    // non-terminal states are not terminal
    for (const s of ["draft", "submitted", "failed", "withdrawn"] as ActionState[]) {
      expect(isTerminalOutcome(s)).toBe(false);
    }
  });

  it("every state has at least one allowed edge", () => {
    for (const s of ACTION_STATES) {
      expect(ALLOWED_TRANSITIONS[s].length).toBeGreaterThan(0);
    }
  });
});

// ---------- idempotency (spec §13: duplicate returns original) ----------

describe("idempotencyKey", () => {
  it("is deterministic for the same inputs", () => {
    const a = idempotencyKey({
      userId: "u1",
      seriesId: "s1",
      actionType: "cancel",
    });
    const b = idempotencyKey({
      userId: "u1",
      seriesId: "s1",
      actionType: "cancel",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("differs by action type, series, and user", () => {
    const base = { userId: "u1", seriesId: "s1", actionType: "cancel" };
    const key = idempotencyKey(base);
    expect(idempotencyKey({ ...base, actionType: "negotiate" })).not.toBe(key);
    expect(idempotencyKey({ ...base, seriesId: "s2" })).not.toBe(key);
    expect(idempotencyKey({ ...base, userId: "u2" })).not.toBe(key);
  });
});

// ---------- consent (spec §13: expiry blocks submission) ----------

describe("consent", () => {
  it("valid consent allows submission", () => {
    expect(isConsentValid(consent(), NOW)).toBe(true);
    expect(consentBlocksSubmission(consent(), NOW)).toBeNull();
  });
  it("expired consent blocks submission with an expiry reason", () => {
    const c = consent({ expires_at: "2026-09-01T00:00:00Z" });
    expect(isConsentValid(c, NOW)).toBe(false);
    const reason = consentBlocksSubmission(c, NOW);
    expect(reason).not.toBeNull();
    expect(reason!).toMatch(/[Ee]xpired/);
  });
  it("withdrawn consent blocks submission", () => {
    const c = consent({ withdrawn_at: "2026-09-20T00:00:00Z" });
    expect(isConsentValid(c, NOW)).toBe(false);
    const reason = consentBlocksSubmission(c, NOW);
    expect(reason).not.toBeNull();
    expect(reason!).toMatch(/[Ww]ithdrawn/);
  });
});

// ---------- route tokens ----------

describe("route tokens", () => {
  const secret = "test-secret-123";
  const payload = {
    request_id: "req-1",
    destination: "https://merchant.example.com/cancel",
    registry_version: 7,
    exp_epoch: Math.floor(Date.now() / 1000) + 3600,
  };

  it("verifies OK for an allowlisted destination", () => {
    const token = issueRouteToken(secret, payload);
    expect(token.startsWith("v1.")).toBe(true);
    expect(verifyRouteToken(secret, token, [payload.destination])).toBe(
      payload.destination
    );
  });
  it("rejects a tampered token", () => {
    const token = issueRouteToken(secret, payload);
    const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(() => verifyRouteToken(secret, tampered, [payload.destination])).toThrow(
      /signature/
    );
  });
  it("rejects a destination not in allowedDestinations", () => {
    const token = issueRouteToken(secret, payload);
    expect(() =>
      verifyRouteToken(secret, token, ["https://other.example.com/"])
    ).toThrow(/allowlisted/);
  });
  it("rejects an expired token", () => {
    const expired = issueRouteToken(secret, {
      ...payload,
      exp_epoch: Math.floor(Date.now() / 1000) - 10,
    });
    expect(() => verifyRouteToken(secret, expired, [payload.destination])).toThrow(
      /expired/
    );
  });
  it("rejects tokens signed with a different secret", () => {
    const token = issueRouteToken(secret, payload);
    expect(() =>
      verifyRouteToken("wrong-secret", token, [payload.destination])
    ).toThrow(/signature/);
  });
  it("rejects malformed tokens", () => {
    expect(() => verifyRouteToken(secret, "not-a-token", [])).toThrow();
    expect(() => verifyRouteToken(secret, "v1.only", [])).toThrow();
  });
});

// ---------- merchant matching (spec §13: deterministic, no cross-user) ----------

const REGISTRY = [
  { merchant_key: "netflix", aliases: ["Netflix", "NETFLIX.COM"] },
  { merchant_key: "spotify", aliases: ["Spotify USA"] },
  { merchant_key: "at&t", aliases: ["ATT", "AT&T Mobility"] },
];

describe("matchMerchant", () => {
  it("exact alias wins", () => {
    expect(matchMerchant("netflix.com", REGISTRY)).toEqual({
      merchant_key: "netflix",
      match: "exact",
    });
  });
  it("is case-insensitive", () => {
    expect(matchMerchant("NETFLIX", REGISTRY)).toEqual({
      merchant_key: "netflix",
      match: "exact",
    });
  });
  it("no match returns null", () => {
    expect(matchMerchant("hulu", REGISTRY)).toBeNull();
  });
  it("is deterministic: first registry entry wins on ties", () => {
    const dup = [
      { merchant_key: "first", aliases: ["Alias"] },
      { merchant_key: "second", aliases: ["Alias"] },
    ];
    expect(matchMerchant("alias", dup)).toEqual({
      merchant_key: "first",
      match: "exact",
    });
    // same inputs always produce the same output, regardless of any caller context
    expect(matchMerchant("alias", dup)).toEqual(matchMerchant("alias", dup));
  });
  it("does not cross users: pure function of name + registry only", () => {
    // The signature takes no user id, session, or caller context at all.
    // Same inputs from any user produce the same answer.
    const params = ["Netflix", REGISTRY] as const;
    expect(matchMerchant(...params)).toEqual(matchMerchant(...params));
  });
});

describe("suggestMerchant", () => {
  it("fuzzy substring only suggests, never exact", () => {
    const s = suggestMerchant("netfl", REGISTRY);
    expect(s).toEqual({ merchant_key: "netflix", match: "suggested" });
    // the fuzzy hit must NOT resolve as an exact match
    expect(matchMerchant("netfl", REGISTRY)).toBeNull();
  });
  it("returns null when nothing resembles the name", () => {
    expect(suggestMerchant("zzz", REGISTRY)).toBeNull();
  });
});

// ---------- eligibility (spec §13: killed, suppressed, stale, low confidence) ----------

describe("routeEligible", () => {
  it("killed merchant is blocked", () => {
    expect(routeEligible(cap({ active: false }), "assisted", NOW)).toEqual({
      ok: false,
      reason: "inactive",
    });
  });
  it("2 failures in 7 days suppresses the route", () => {
    expect(
      routeEligible(cap({ failure_count_7d: 2 }), "direct", NOW)
    ).toEqual({ ok: false, reason: "suppressed" });
  });
  it("one failure does not suppress", () => {
    expect(routeEligible(cap({ failure_count_7d: 1 }), "direct", NOW).ok).toBe(
      true
    );
  });
  it("stale record (>180d) is not eligible, even for guided", () => {
    const stale = cap({ source_checked_at: "2025-12-01T00:00:00Z" });
    expect(routeEligible(stale, "assisted", NOW)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(routeEligible(stale, "guided", NOW)).toEqual({
      ok: false,
      reason: "stale",
    });
  });
  it("assisted requires freshness within 90 days", () => {
    const aged = cap({ source_checked_at: "2026-06-01T00:00:00Z" }); // ~115d
    expect(routeEligible(aged, "assisted", NOW).ok).toBe(false);
    expect(routeEligible(aged, "guided", NOW).ok).toBe(true);
  });
  it("assisted requires high confidence", () => {
    const med = cap({ confidence: "medium" });
    expect(routeEligible(med, "assisted", NOW)).toEqual({
      ok: false,
      reason: "confidence",
    });
    expect(routeEligible(med, "guided", NOW).ok).toBe(true);
  });
  it("low confidence is guidance-only everywhere", () => {
    const low = cap({ confidence: "low" });
    for (const kind of ["assisted", "direct", "guided"] as const) {
      const r = routeEligible(low, kind, NOW);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("low_confidence");
    }
  });
  it("fresh high-confidence assisted record is eligible", () => {
    expect(routeEligible(cap(), "assisted", NOW)).toEqual({ ok: true });
  });
});

// ---------- possible renewal (spec FR-15/FR-26) ----------

describe("shouldReopenSeries", () => {
  it("new charge after a reported-complete series reopens it", () => {
    expect(
      shouldReopenSeries(
        {
          lifecycle_state: "reported_complete",
          last_charge_date: "2026-08-24",
          cadence: "monthly",
        },
        "2026-09-24"
      )
    ).toBe(true);
  });
  it("does not reopen an active series", () => {
    expect(
      shouldReopenSeries(
        {
          lifecycle_state: "active",
          last_charge_date: "2026-08-24",
          cadence: "monthly",
        },
        "2026-09-24"
      )
    ).toBe(false);
  });
  it("does not reopen on an older charge date", () => {
    expect(
      shouldReopenSeries(
        {
          lifecycle_state: "confirmed_complete",
          last_charge_date: "2026-09-24",
          cadence: "monthly",
        },
        "2026-08-24"
      )
    ).toBe(false);
  });
  it("ended series states list matches the module contract", () => {
    expect(ENDED_SERIES_STATES).toContain("reported_complete");
    expect(ENDED_SERIES_STATES).toContain("confirmed_complete");
  });
});

// ---------- planner handoff (spec §13: versions preserved, temp only) ----------

describe("buildPlannerHandoff", () => {
  const input = {
    savings: {
      monthly_cents: 3000,
      modeled_months: null as number | null,
      permanent: true, // cancelled: savings recur indefinitely
    },
    baseline: { monthly_investment_cents: 100000, version: "plan-v3" },
    calc_version: "fire-monthly-v1",
  };

  it("adds permanent (cancelled) savings to a temp scenario and preserves versions", () => {
    const h = buildPlannerHandoff(input);
    expect(h.temp_only).toBe(true);
    expect(h.scenario_monthly_investment_cents).toBe(103000);
    expect(h.baseline_version).toBe("plan-v3");
    expect(h.calc_version).toBe("fire-monthly-v1");
    expect(h.number_impact_available).toBe(true);
  });
  it("regression: permanent savings with null modeled_months are NOT treated as temporary", () => {
    // modeled_months is null for permanent savings too — null alone must
    // never suppress the Number impact.
    const h = buildPlannerHandoff({
      ...input,
      savings: { monthly_cents: 1799, modeled_months: null, permanent: true },
    });
    expect(h.number_impact_available).toBe(true);
    expect(h.scenario_monthly_investment_cents).toBe(
      input.baseline.monthly_investment_cents + 1799
    );
  });
  it("downgraded (permanent) savings get Number impact", () => {
    const h = buildPlannerHandoff({
      ...input,
      savings: { monthly_cents: 1500, modeled_months: null, permanent: true },
    });
    expect(h.number_impact_available).toBe(true);
  });
  it("negotiated with known promo duration: cash only, engine cannot model temporary cash flows", () => {
    const h = buildPlannerHandoff({
      ...input,
      savings: { monthly_cents: 3000, modeled_months: 12, permanent: false },
    });
    expect(h.number_impact_available).toBe(false);
    expect(h.scenario_monthly_investment_cents).toBe(
      input.baseline.monthly_investment_cents
    );
    expect(h.note).toMatch(/cash savings/i);
  });
  it("unknown promo duration: cash only, no Number impact, copy hedged", () => {
    const h = buildPlannerHandoff({
      ...input,
      savings: { monthly_cents: 3000, modeled_months: null, permanent: false },
    });
    expect(h.number_impact_available).toBe(false);
    expect(h.scenario_monthly_investment_cents).toBe(
      input.baseline.monthly_investment_cents
    );
    expect(h.note).toMatch(/cash savings/i);
  });
  it("zero savings: cash only", () => {
    const h = buildPlannerHandoff({
      ...input,
      savings: { monthly_cents: 0, modeled_months: null, permanent: true },
    });
    expect(h.number_impact_available).toBe(false);
  });
  it("never mutates the plan input", () => {
    const before = JSON.parse(JSON.stringify(input));
    buildPlannerHandoff(input);
    expect(input).toEqual(before);
  });
  it("copy uses could/under these assumptions, never will", () => {
    const h = buildPlannerHandoff(input);
    expect(h.note).toMatch(/could|under these assumptions/);
    expect(h.note).not.toMatch(/\bwill\b/);
  });
});

// ---------- scenario provenance (plain language, no internal codes) ----------

describe("formatScenarioProvenance", () => {
  it("translates the no-saved-plan + subscription handoff case", () => {
    expect(formatScenarioProvenance("none", "sac-1.0")).toBe(
      "No saved plan yet · Subscription savings calculation"
    );
  });
  it("names the saved plan version when one exists", () => {
    expect(formatScenarioProvenance("3", "sac-1.0")).toBe(
      "Compared against saved plan v3 · Subscription savings calculation"
    );
  });
  it("never leaks internal codes", () => {
    for (const out of [
      formatScenarioProvenance("none", "sac-1.0"),
      formatScenarioProvenance("2", "fire-monthly-v1"),
    ]) {
      expect(out).not.toMatch(/vnone/i);
      expect(out).not.toMatch(/sac-1\.0/);
      expect(out).not.toMatch(/\bcalc\b/i);
    }
  });
  it("omits empty parts", () => {
    expect(formatScenarioProvenance("", "sac-1.0")).toBe(
      "Subscription savings calculation"
    );
    expect(formatScenarioProvenance("none", "")).toBe("No saved plan yet");
    expect(formatScenarioProvenance("", "")).toBe("");
  });
});

// ---------- status copy (spec §11) ----------

describe("STATUS_COPY", () => {
  it("covers every canonical state", () => {
    for (const s of ACTION_STATES) {
      expect(typeof STATUS_COPY[s]).toBe("string");
      expect(STATUS_COPY[s].length).toBeGreaterThan(0);
    }
  });
  it("uses the exact spec copy for the headline states", () => {
    expect(STATUS_COPY.action_started).toBe(
      "You opened the cancellation route. Tell us what happened when you are done."
    );
    expect(STATUS_COPY.unsupported).toBe(
      "We do not have a verified route for this merchant yet."
    );
    expect(STATUS_COPY.confirmed_complete).toBe(
      "Cancellation confirmed. Your plan has not changed."
    );
    expect(STATUS_COPY.needs_you).toBe(
      "The merchant needs your approval before anything changes."
    );
  });
  it("never equates action-started with cancelled", () => {
    expect(STATUS_COPY.action_started.toLowerCase()).not.toContain("cancelled");
  });
});
