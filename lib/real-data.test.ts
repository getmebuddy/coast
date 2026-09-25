import { describe, expect, it } from "vitest";
import {
  resolveViewMode,
  missingPrerequisites,
  budgetLeftPerDay,
  localMonthKey,
  localMonthStart,
  localDay,
  daysRemainingInclusive,
  validTimezone,
  containsDemoProvenance,
  assertNoDemoProvenance,
  containsDemoSentinel,
  encodeCursor,
  decodeCursor,
  effectiveCategory,
  REMOVED_MARKER,
  type ViewFacts,
} from "./real-data";

const baseFacts: ViewFacts = {
  authenticated: true,
  authError: false,
  realDataEnabled: true,
  hasActiveItem: true,
  syncCompleted: true,
  txnCount: 10,
  hasBudget: true,
  hasNumber: true,
};

// ---------- resolveViewMode ----------

describe("resolveViewMode", () => {
  it("resolves demo when signed out", () => {
    expect(resolveViewMode({ ...baseFacts, authenticated: false })).toBe("demo");
  });
  it("resolves error when the auth service fails", () => {
    expect(resolveViewMode({ ...baseFacts, authError: true })).toBe("error");
  });
  it("fail-closes to unavailable when the release switch is off (never demo)", () => {
    expect(resolveViewMode({ ...baseFacts, realDataEnabled: false })).toBe("unavailable");
  });
  it("resolves setup with no bank connection", () => {
    expect(resolveViewMode({ ...baseFacts, hasActiveItem: false })).toBe("setup");
  });
  it("resolves syncing on first sync with no rows", () => {
    expect(resolveViewMode({ ...baseFacts, syncCompleted: false, txnCount: 0 })).toBe("syncing");
  });
  it("resolves partial after a completed sync with zero rows", () => {
    expect(resolveViewMode({ ...baseFacts, txnCount: 0 })).toBe("partial");
  });
  it("resolves partial when budget or number is missing", () => {
    expect(resolveViewMode({ ...baseFacts, hasBudget: false })).toBe("partial");
    expect(resolveViewMode({ ...baseFacts, hasNumber: false })).toBe("partial");
  });
  it("resolves real when everything is present", () => {
    expect(resolveViewMode(baseFacts)).toBe("real");
  });
  it("never resolves demo for an authenticated session", () => {
    const modes = [
      { ...baseFacts, realDataEnabled: false },
      { ...baseFacts, hasActiveItem: false },
      { ...baseFacts, syncCompleted: false, txnCount: 0 },
    ].map(resolveViewMode);
    expect(modes).not.toContain("demo");
  });
});

describe("missingPrerequisites", () => {
  it("labels each missing prerequisite", () => {
    expect(missingPrerequisites({ ...baseFacts, hasActiveItem: false, hasBudget: false })).toEqual([
      "bank",
      "budget",
    ]);
  });
  it("is empty when nothing is missing", () => {
    expect(missingPrerequisites(baseFacts)).toEqual([]);
  });
});

// ---------- budgetLeftPerDay ----------

describe("budgetLeftPerDay", () => {
  it("divides the remainder over days left, rounded down", () => {
    expect(budgetLeftPerDay({ ceilingCents: 100000, postedSpendingCents: 25000, daysRemaining: 10 })).toBe(7500);
    // 75001 / 10 = 7500.1 -> floor
    expect(budgetLeftPerDay({ ceilingCents: 100001, postedSpendingCents: 25000, daysRemaining: 10 })).toBe(7500);
  });
  it("floors at zero when over budget", () => {
    expect(budgetLeftPerDay({ ceilingCents: 50000, postedSpendingCents: 60000, daysRemaining: 5 })).toBe(0);
  });
  it("clamps days remaining to at least one", () => {
    expect(budgetLeftPerDay({ ceilingCents: 9000, postedSpendingCents: 0, daysRemaining: 0 })).toBe(9000);
    expect(budgetLeftPerDay({ ceilingCents: 9000, postedSpendingCents: 0, daysRemaining: -3 })).toBe(9000);
  });
});

// ---------- timezone helpers ----------

describe("timezone helpers", () => {
  it("validTimezone accepts valid IANA names and falls back otherwise", () => {
    expect(validTimezone("America/Chicago")).toBe("America/Chicago");
    expect(validTimezone("Pacific/Auckland")).toBe("Pacific/Auckland");
    expect(validTimezone("not/a-zone")).toBe("America/Chicago");
    expect(validTimezone(null)).toBe("America/Chicago");
    expect(validTimezone("")).toBe("America/Chicago");
  });

  it("computes the local month in the profile timezone", () => {
    // 2026-09-25 04:30 UTC is still Sep 24 in Chicago (UTC-5).
    const d = new Date("2026-09-25T04:30:00Z");
    expect(localMonthKey(d, "America/Chicago")).toBe("2026-09");
    expect(localMonthStart(d, "America/Chicago")).toBe("2026-09-01");
    // Same instant is Sep 25 in Auckland (UTC+12).
    expect(localDay(d, "Pacific/Auckland")).toBe("2026-09-25");
    expect(localDay(d, "America/Chicago")).toBe("2026-09-24");
  });

  it("handles a month boundary across timezones", () => {
    // 2026-10-01 03:00 UTC = Sep 30 22:00 Chicago.
    const d = new Date("2026-10-01T03:00:00Z");
    expect(localMonthKey(d, "America/Chicago")).toBe("2026-09");
    expect(localMonthKey(d, "UTC")).toBe("2026-10");
  });

  it("counts inclusive days remaining, never below one", () => {
    expect(daysRemainingInclusive(new Date("2026-09-25T12:00:00Z"), "America/Chicago")).toBe(6);
    expect(daysRemainingInclusive(new Date("2026-09-30T23:00:00-05:00"), "America/Chicago")).toBe(1);
    expect(daysRemainingInclusive(new Date("2026-02-15T12:00:00Z"), "America/Chicago")).toBe(14); // 2026 not a leap year
  });

  it("survives a daylight-saving transition (US spring forward)", () => {
    // 2026-03-08 08:30 UTC = 02:30 CST -> 03:30 CDT Chicago (spring forward).
    const d = new Date("2026-03-08T08:30:00Z");
    expect(localDay(d, "America/Chicago")).toBe("2026-03-08");
    expect(localMonthKey(d, "America/Chicago")).toBe("2026-03");
  });
});

// ---------- demo-provenance guard ----------

describe("demo provenance guard", () => {
  it("detects demo leakage in an envelope", () => {
    expect(containsDemoProvenance({ provenance: { rows: "real", budget: "demo" } })).toBe(true);
    expect(containsDemoProvenance({ provenance: { rows: "real", budget: "missing" } })).toBe(false);
  });
  it("assertNoDemoProvenance throws on leakage", () => {
    expect(() =>
      assertNoDemoProvenance({ provenance: { home: "demo" } }, "home")
    ).toThrow(/demo provenance leaked/);
    expect(() =>
      assertNoDemoProvenance({ provenance: { home: "real" } }, "home")
    ).not.toThrow();
  });
});

// ---------- sentinel leakage ----------

describe("containsDemoSentinel", () => {
  it("flags known demo merchants in a payload", () => {
    expect(containsDemoSentinel({ merchant: "Whole Foods", amountCents: -100 })).toBe(true);
    expect(containsDemoSentinel([{ merchant: "Target" }])).toBe(true);
  });
  it("flags known demo amounts with boundary checks", () => {
    expect(containsDemoSentinel({ amountCents: -10619 })).toBe(true);
  });
  it("does not flag ordinary real-looking data", () => {
    expect(containsDemoSentinel({ merchant: "Acme Corp", amountCents: -4213 })).toBe(false);
    // -106199 contains -10619 as a substring but is a different amount.
    expect(containsDemoSentinel({ amountCents: -106199 })).toBe(false);
  });
  it("never flags a clean signed-in view model shape", () => {
    const clean = {
      mode: "real",
      provenance: { rows: "real" },
      data: { rows: [{ merchant: "Acme Corp", amountCents: -4213, category: "Other" }] },
    };
    expect(containsDemoSentinel(clean)).toBe(false);
  });
});

// ---------- cursor ----------

describe("activity cursor", () => {
  it("round-trips through base64url", () => {
    const c = { posted_at: "2026-09-20", ingested_at: "2026-09-21T10:00:00Z", id: "abc-123" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("rejects garbage", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBe(null);
    expect(decodeCursor(encodeCursor({ posted_at: "x" } as never))).toBe(null);
  });
});

// ---------- effectiveCategory ----------

function testLedger() {
  return {
    txns: [],
    accountNames: new Map<string, string>(),
    overrides: new Map<string, string>(),
    rules: [{ matchPattern: "acme", category: "Work" }],
    splits: new Map<string, Array<{ category: string; amount_cents: number }>>(),
  };
}

function txn(id: string, merchant: string) {
  return {
    id,
    posted_at: "2026-09-20",
    ingested_at: "2026-09-21T10:00:00Z",
    merchant_normalized: merchant,
    amount_cents: -1000,
    kind: "expense" as const,
    pending: false,
    account_id: null,
  };
}

describe("effectiveCategory", () => {
  it("marks bank-removed rows via the override marker", () => {
    const ledger = testLedger();
    ledger.overrides.set("t1", REMOVED_MARKER);
    const out = effectiveCategory(ledger, txn("t1", "Acme Store"));
    expect(out.removed).toBe(true);
    expect(out.category).toBe(REMOVED_MARKER);
  });
  it("prefers user overrides over rules", () => {
    const ledger = testLedger();
    ledger.overrides.set("t2", "Personal");
    expect(effectiveCategory(ledger, txn("t2", "Acme Store")).category).toBe("Personal");
  });
  it("applies user rules before the default map", () => {
    const ledger = testLedger();
    expect(effectiveCategory(ledger, txn("t3", "Acme Store")).category).toBe("Work");
  });
  it("falls back to the deterministic default map", () => {
    const ledger = testLedger();
    // Whole Foods is in the default map -> Groceries.
    expect(effectiveCategory(ledger, txn("t4", "Whole Foods")).category).toBe("Groceries");
    expect(effectiveCategory(ledger, txn("t5", "Some Unknown Place")).category).toBe("Other");
  });
  it("labels split transactions", () => {
    const ledger = testLedger();
    ledger.splits.set("t6", [{ category: "Groceries", amount_cents: 600 }]);
    const out = effectiveCategory(ledger, txn("t6", "Acme Store"));
    expect(out.split).toBe(true);
    expect(out.category).toBe("Split");
  });
});
