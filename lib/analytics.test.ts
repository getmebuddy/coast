import { describe, expect, it } from "vitest";
import { isValidPilotCohort, trackPilotEvent, validatePilotEvent } from "./analytics";

// ---------- validatePilotEvent ----------

describe("validatePilotEvent", () => {
  it("accepts a known event with bucket-only props", () => {
    const out = validatePilotEvent("morning_brief_viewed", {});
    expect(out.name).toBe("morning_brief_viewed");
    expect(out.props).toEqual({});
  });

  it("accepts safe label props", () => {
    const out = validatePilotEvent("account_link_failed", { stage: "token-exchange" });
    expect(out.props).toEqual({ stage: "token-exchange" });
  });

  it("rejects unknown events", () => {
    expect(() => validatePilotEvent("user_did_a_thing", {})).toThrow(/unknown event/);
  });

  it("rejects props that smell like money", () => {
    expect(() => validatePilotEvent("number_completed", { portfolio_cents: "100" })).toThrow(
      /raw financial value/
    );
  });

  it("rejects props that smell like PII", () => {
    expect(() => validatePilotEvent("signup_completed", { email: "a@b.c" })).toThrow(/PII/);
    expect(() => validatePilotEvent("signup_completed", { institution_name: "Chase" })).toThrow(
      /PII/
    );
  });

  it("rejects non-string prop values", () => {
    expect(() =>
      validatePilotEvent("what_if_saved", { scenario: 42 as unknown as string })
    ).toThrow(/short string label/);
  });

  it("rejects oversized prop values", () => {
    expect(() =>
      validatePilotEvent("what_if_saved", { scenario: "x".repeat(121) })
    ).toThrow(/short string label/);
  });

  it("rejects too many props", () => {
    const props: Record<string, string> = {};
    for (let i = 0; i < 13; i++) props[`k${i}`] = "v";
    expect(() => validatePilotEvent("what_if_saved", props)).toThrow(/too many props/);
  });
});

describe("isValidPilotCohort", () => {
  it("accepts undefined and slug-like cohorts", () => {
    expect(isValidPilotCohort(undefined)).toBe(true);
    expect(isValidPilotCohort("founding-2026-09")).toBe(true);
  });

  it("rejects freeform strings", () => {
    expect(isValidPilotCohort("Founding Cohort!")).toBe(false);
    expect(isValidPilotCohort("../../etc")).toBe(false);
  });
});

describe("trackPilotEvent (client)", () => {
  it("is a no-op outside the browser and never throws", () => {
    // No window in the vitest node environment — must not throw.
    expect(() => trackPilotEvent("morning_brief_viewed", {})).not.toThrow();
  });

  it("throws in dev for invalid events so bad call sites fail fast", () => {
    expect(() => trackPilotEvent("bogus_event" as never, {})).toThrow(/unknown event/);
  });
});
