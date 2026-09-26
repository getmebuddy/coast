/**
 * Tests for the Routines detection library — pure, ledger-driven.
 * Money: integer cents (positive). Dates: YYYY-MM-DD.
 */
import { describe, expect, it } from "vitest";
import {
  detectDuplicates,
  detectFeeSweep,
  detectOverlap,
  detectPossibleTrials,
  detectPriceHikes,
  matchRefunds,
  type RoutineTxn,
} from "./routines";

function txn(partial: Partial<RoutineTxn> & { id: string }): RoutineTxn {
  return {
    merchant: "Test Merchant",
    amount_cents: -1000,
    date: "2026-09-10",
    kind: "expense",
    ...partial,
  };
}

describe("detectPriceHikes", () => {
  it("flags a stable subscription that raised its price", () => {
    const txns = [
      txn({ id: "n1", merchant: "Netflix", amount_cents: -1549, date: "2026-06-15" }),
      txn({ id: "n2", merchant: "Netflix", amount_cents: -1549, date: "2026-07-15" }),
      txn({ id: "n3", merchant: "Netflix", amount_cents: -1549, date: "2026-08-15" }),
      txn({ id: "n4", merchant: "Netflix", amount_cents: -1799, date: "2026-09-15" }),
    ];
    const findings = detectPriceHikes(txns);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.routine_key).toBe("price_hike");
    expect(f.title).toBe("Netflix raised its price");
    expect(f.detail).toContain("$15.49");
    expect(f.detail).toContain("$17.99");
    expect(f.impact_cents).toBe(250 * 12); // annualized hike
    expect(f.dedupe_hash).toBe("price_hike:Netflix:1549:1799");
  });

  it("stays quiet when prices are stable", () => {
    const txns = [
      txn({ id: "s1", merchant: "Spotify", amount_cents: -999, date: "2026-06-15" }),
      txn({ id: "s2", merchant: "Spotify", amount_cents: -999, date: "2026-07-15" }),
      txn({ id: "s3", merchant: "Spotify", amount_cents: -999, date: "2026-08-15" }),
    ];
    expect(detectPriceHikes(txns)).toHaveLength(0);
  });
});

describe("detectDuplicates", () => {
  it("flags two near-identical charges days apart", () => {
    const txns = [
      txn({ id: "a1", merchant: "Amazon", amount_cents: -4599, date: "2026-09-10" }),
      txn({ id: "a2", merchant: "Amazon", amount_cents: -4599, date: "2026-09-12" }),
    ];
    const findings = detectDuplicates(txns);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.kind).toBe("duplicate_charge");
    expect(f.title).toBe("Possible duplicate charge");
    expect(f.impact_cents).toBe(4599);
    expect(f.evidence.transactions).toHaveLength(2);
  });

  it("ignores charges a week apart (not duplicates)", () => {
    const txns = [
      txn({ id: "a1", merchant: "Amazon", amount_cents: -4599, date: "2026-09-01" }),
      txn({ id: "a2", merchant: "Amazon", amount_cents: -4599, date: "2026-09-10" }),
    ];
    expect(detectDuplicates(txns)).toHaveLength(0);
  });

  it("does not flag a clean weekly series", () => {
    const txns = [
      txn({ id: "c1", merchant: "Coffee", amount_cents: -500, date: "2026-09-01" }),
      txn({ id: "c2", merchant: "Coffee", amount_cents: -500, date: "2026-09-08" }),
      txn({ id: "c3", merchant: "Coffee", amount_cents: -500, date: "2026-09-15" }),
    ];
    expect(detectDuplicates(txns)).toHaveLength(0);
  });

  it("does not double-count a transaction in two clusters", () => {
    const txns = [
      txn({ id: "a1", merchant: "Amazon", amount_cents: -1000, date: "2026-09-10" }),
      txn({ id: "a2", merchant: "Amazon", amount_cents: -1000, date: "2026-09-11" }),
      txn({ id: "a3", merchant: "Amazon", amount_cents: -1000, date: "2026-09-12" }),
    ];
    const findings = detectDuplicates(txns);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.transactions).toHaveLength(3);
  });
});

describe("detectFeeSweep", () => {
  it("digests bank and late fees from the last 30 days", () => {
    const txns = [
      txn({ id: "f1", merchant: "Overdraft", amount_cents: -3500, date: "2026-09-05", kind: "fee" }),
      txn({ id: "f2", merchant: "Late Fee", amount_cents: -2500, date: "2026-09-10" }),
      txn({ id: "f3", merchant: "Old Fee", amount_cents: -1000, date: "2026-07-01", kind: "fee" }),
    ];
    const findings = detectFeeSweep(txns, "2026-09-26");
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.impact_cents).toBe(6000);
    expect(f.detail).toContain("$60.00");
    expect(f.detail).toContain("2 charges");
    expect(f.evidence.fee_count).toBe(2);
    expect(f.dedupe_hash).toBe("fee_sweep:2026-09");
  });

  it("returns nothing when there are no fees", () => {
    const txns = [txn({ id: "g1", merchant: "Grocery", amount_cents: -5000, date: "2026-09-10" })];
    expect(detectFeeSweep(txns, "2026-09-26")).toHaveLength(0);
  });
});

describe("detectOverlap", () => {
  const monthly = (merchant: string, cents: number, ids: string[]) =>
    ids.map((id, i) =>
      txn({
        id,
        merchant,
        amount_cents: -cents,
        date: `2026-0${6 + i}-15`,
      })
    );

  it("flags two music subscriptions", () => {
    const txns = [
      ...monthly("Spotify", 999, ["s1", "s2", "s3"]),
      ...monthly("Apple Music", 1099, ["m1", "m2", "m3"]),
    ];
    const findings = detectOverlap(txns);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.kind).toBe("overlap");
    expect(f.title).toBe("Two music subscriptions");
    expect(f.detail).toContain("Apple Music and Spotify");
    expect(f.impact_cents).toBe(999 + 1099);
  });

  it("stays quiet with a single subscription per category", () => {
    const txns = monthly("Netflix", 1799, ["n1", "n2", "n3"]);
    expect(detectOverlap(txns)).toHaveLength(0);
  });
});

describe("detectPossibleTrials", () => {
  it("flags a small charge followed by a larger one as a possible trial", () => {
    const txns = [
      txn({ id: "t1", merchant: "App Trial", amount_cents: -199, date: "2026-08-01" }),
      txn({ id: "t2", merchant: "App Trial", amount_cents: -1499, date: "2026-08-31" }),
    ];
    const findings = detectPossibleTrials(txns);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.title).toBe("Possible trial: App Trial");
    expect(f.detail).toContain("paid plan has started");
    expect(f.impact_cents).toBe(1499);
    expect(f.dedupe_hash).toBe("trial:App Trial:2026-08-01:2026-08-31");
  });

  it("ignores two identical charges", () => {
    const txns = [
      txn({ id: "t1", merchant: "App", amount_cents: -999, date: "2026-08-01" }),
      txn({ id: "t2", merchant: "App", amount_cents: -999, date: "2026-08-31" }),
    ];
    expect(detectPossibleTrials(txns)).toHaveLength(0);
  });

  it("ignores a step-up outside the trial window", () => {
    const txns = [
      txn({ id: "t1", merchant: "App", amount_cents: -199, date: "2026-01-01" }),
      txn({ id: "t2", merchant: "App", amount_cents: -1499, date: "2026-08-31" }),
    ];
    expect(detectPossibleTrials(txns)).toHaveLength(0);
  });
});

describe("matchRefunds", () => {
  const expected = { id: "exp1", merchant: "Store", amount_cents: 3300, expected_date: "2026-09-20" };

  it("flags a shortfall with the exact dollar gap", () => {
    const txns = [
      txn({ id: "c1", merchant: "Store", amount_cents: 2800, date: "2026-09-22", kind: "refund" }),
    ];
    const { matched, shortfalls } = matchRefunds([expected], txns);
    expect(matched).toHaveLength(0);
    expect(shortfalls).toHaveLength(1);
    const f = shortfalls[0];
    expect(f.kind).toBe("refund_shortfall");
    expect(f.title).toBe("Refund shortfall: Store");
    expect(f.detail).toContain("$33.00");
    expect(f.detail).toContain("$28.00");
    expect(f.detail).toContain("$5.00");
    expect(f.impact_cents).toBe(500);
    expect(f.dedupe_hash).toBe("refund_shortfall:exp1");
  });

  it("marks a full refund as matched", () => {
    const txns = [
      txn({ id: "c1", merchant: "Store", amount_cents: 3300, date: "2026-09-22", kind: "refund" }),
    ];
    const { matched, shortfalls } = matchRefunds([expected], txns);
    expect(matched).toHaveLength(1);
    expect(matched[0].txn.id).toBe("c1");
    expect(shortfalls).toHaveLength(0);
  });

  it("tolerates a few cents of rounding", () => {
    const txns = [
      txn({ id: "c1", merchant: "Store", amount_cents: 3290, date: "2026-09-22", kind: "refund" }),
    ];
    const { matched, shortfalls } = matchRefunds([expected], txns);
    expect(matched).toHaveLength(1);
    expect(shortfalls).toHaveLength(0);
  });

  it("confirms unregistered refunds without flagging a shortfall", () => {
    const txns = [
      txn({ id: "c9", merchant: "Other Store", amount_cents: 1200, date: "2026-09-22", kind: "refund" }),
    ];
    const { matched, shortfalls, received } = matchRefunds([], txns);
    expect(matched).toHaveLength(0);
    expect(shortfalls).toHaveLength(0);
    expect(received).toHaveLength(1);
    expect(received[0].impact_cents).toBe(0);
  });
});
