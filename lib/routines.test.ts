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
  detectSpendAnomaly,
  detectTrialEndings,
  detectWatchlist,
  matchRefunds,
  type RoutineTxn,
  type WatchlistInput,
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

describe("detectWatchlist", () => {
  const coffee: WatchlistInput = {
    id: "wl-1",
    name: "Coffee shops",
    target_kind: "merchant",
    target: "blue bottle",
    threshold_cents: 3000,
  };

  it("fires when month-to-date spend crosses the threshold", () => {
    const txns = [
      txn({ id: "c1", merchant: "Blue Bottle Coffee", amount_cents: -1800, date: "2026-09-05" }),
      txn({ id: "c2", merchant: "Blue Bottle Coffee", amount_cents: -1500, date: "2026-09-20" }),
    ];
    const findings = detectWatchlist(txns, [coffee], "2026-09");
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.routine_key).toBe("watchlist");
    expect(f.title).toBe("Watchlist: Coffee shops passed $30.00");
    expect(f.detail).toContain("$33.00");
    expect(f.detail).toContain("$3.00 over");
    expect(f.impact_cents).toBe(3300);
    expect(f.dedupe_hash).toBe("watchlist:wl-1:2026-09");
    expect(f.evidence.transactions).toHaveLength(2);
  });

  it("stays quiet under the threshold and ignores other months", () => {
    const txns = [
      txn({ id: "c1", merchant: "Blue Bottle Coffee", amount_cents: -1800, date: "2026-09-05" }),
      txn({ id: "c2", merchant: "Blue Bottle Coffee", amount_cents: -1500, date: "2026-08-20" }),
    ];
    expect(detectWatchlist(txns, [coffee], "2026-09")).toHaveLength(0);
  });

  it("matches categories exactly (case-insensitive) and ignores pending", () => {
    const wl: WatchlistInput = {
      id: "wl-2",
      name: "Dining",
      target_kind: "category",
      target: "dining",
      threshold_cents: 5000,
    };
    const txns = [
      txn({ id: "d1", merchant: "Taco Spot", amount_cents: -3000, date: "2026-09-05", category: "Dining" }),
      txn({ id: "d2", merchant: "Sushi Bar", amount_cents: -3000, date: "2026-09-06", category: "Dining", pending: true }),
      txn({ id: "d3", merchant: "Grocery", amount_cents: -3000, date: "2026-09-07", category: "Groceries" }),
    ];
    expect(detectWatchlist(txns, [wl], "2026-09")).toHaveLength(0);
  });

  it("excludes transfers and income from merchant matching", () => {
    const txns = [
      txn({ id: "t1", merchant: "Blue Bottle", amount_cents: -40000, date: "2026-09-05", kind: "transfer" }),
      txn({ id: "i1", merchant: "Blue Bottle", amount_cents: 50000, date: "2026-09-06", kind: "income" }),
    ];
    expect(detectWatchlist(txns, [coffee], "2026-09")).toHaveLength(0);
  });
});

describe("detectSpendAnomaly", () => {
  // now = 2026-09-27 (Sunday). Baseline weeks sit in 2026-08-24..2026-09-20,
  // this week is 2026-09-21..2026-09-27, Monday of this week is 2026-09-21.
  const NOW = "2026-09-27";
  const dining = (id: string, cents: number, date: string, category = "Dining") =>
    txn({ id, merchant: "Restaurant", amount_cents: -cents, date, category });

  const baseline = [
    dining("b1", 5000, "2026-08-25"),
    dining("b2", 5000, "2026-09-01"),
    dining("b3", 5000, "2026-09-08"),
    dining("b4", 5000, "2026-09-15"),
  ];
  const warmupOld = dining("w0", 5000, "2026-08-20"); // pushes history past 5 weeks

  it("fires when a week is >=2x the 4-week average and $50+ over", () => {
    const txns = [
      warmupOld,
      ...baseline,
      dining("s1", 8000, "2026-09-23"),
      dining("s2", 4000, "2026-09-25"),
    ];
    const findings = detectSpendAnomaly(txns, NOW);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.routine_key).toBe("spend_anomaly");
    expect(f.kind).toBe("spend_anomaly");
    expect(f.title).toBe("Unusual spend: Dining");
    expect(f.detail).toContain("2.4x");
    expect(f.detail).toContain("$70.00");
    expect(f.impact_cents).toBe(7000);
    expect(f.evidence.transactions).toHaveLength(2);
    expect(f.dedupe_hash).toBe("spend_anomaly:Dining:2026-09-21");
  });

  it("stays quiet when the delta is under $50 even at 2x", () => {
    const txns = [
      dining("w0", 1000, "2026-08-20"),
      dining("b1", 1000, "2026-08-25"),
      dining("b2", 1000, "2026-09-01"),
      dining("b3", 1000, "2026-09-08"),
      dining("b4", 1000, "2026-09-15"),
      dining("s1", 2000, "2026-09-23"), // 2x average but only $10 over
    ];
    expect(detectSpendAnomaly(txns, NOW)).toHaveLength(0);
  });

  it("stays quiet when the week is under 2x even with a large delta", () => {
    const txns = [
      dining("w0", 20000, "2026-08-20"),
      dining("b1", 20000, "2026-08-25"),
      dining("b2", 20000, "2026-09-01"),
      dining("b3", 20000, "2026-09-08"),
      dining("b4", 20000, "2026-09-15"),
      dining("s1", 25000, "2026-09-23"), // 1.25x: $50 over but not 2x
    ];
    expect(detectSpendAnomaly(txns, NOW)).toHaveLength(0);
  });

  it("stays quiet with less than 5 weeks of history (warmup)", () => {
    const txns = [
      dining("b2", 5000, "2026-09-01"),
      dining("b3", 5000, "2026-09-08"),
      dining("b4", 5000, "2026-09-15"),
      dining("s1", 12000, "2026-09-23"), // spike, but oldest txn is 26 days old
    ];
    expect(detectSpendAnomaly(txns, NOW)).toHaveLength(0);
  });

  it("produces the same findings across identical runs (dedupe stable)", () => {
    const txns = [
      warmupOld,
      ...baseline,
      dining("s1", 8000, "2026-09-23"),
      dining("s2", 4000, "2026-09-25"),
    ];
    const first = detectSpendAnomaly(txns, NOW);
    const second = detectSpendAnomaly(txns, NOW);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].dedupe_hash).toBe(first[0].dedupe_hash);
    expect(second[0].detail).toBe(first[0].detail);
  });

  it("skips transactions with no category", () => {
    const txns = [
      warmupOld,
      ...baseline,
      txn({ id: "x1", merchant: "Unknown Shop", amount_cents: -12000, date: "2026-09-23" }),
    ];
    expect(detectSpendAnomaly(txns, NOW)).toHaveLength(0);
  });
});

describe("detectTrialEndings", () => {
  const NOW = "2026-09-27";

  it("fires for a trial ending 2 days out", () => {
    const findings = detectTrialEndings(
      [{ merchant: "Acme Streaming", trial_ends_on: "2026-09-29", last_amount_cents: 1599 }],
      NOW
    );
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.routine_key).toBe("trial_watch");
    expect(f.kind).toBe("trial_ending");
    expect(f.title).toBe("Your Acme Streaming trial ends in 2 days");
    expect(f.detail).toContain("2026-09-29");
    expect(f.impact_cents).toBe(1599);
    expect(f.dedupe_hash).toBe("trial_end:Acme Streaming:2026-09-29");
  });

  it("says 'ends today' and 'ends tomorrow' on day 0 and day 1", () => {
    const today = detectTrialEndings(
      [{ merchant: "Acme Streaming", trial_ends_on: NOW }],
      NOW
    );
    expect(today[0].title).toBe("Your Acme Streaming trial ends today");
    const tomorrow = detectTrialEndings(
      [{ merchant: "Acme Streaming", trial_ends_on: "2026-09-28" }],
      NOW
    );
    expect(tomorrow[0].title).toBe("Your Acme Streaming trial ends tomorrow");
  });

  it("stays quiet 4 days out and for past dates", () => {
    expect(
      detectTrialEndings([{ merchant: "Far App", trial_ends_on: "2026-10-01" }], NOW)
    ).toHaveLength(0);
    expect(
      detectTrialEndings([{ merchant: "Past App", trial_ends_on: "2026-09-26" }], NOW)
    ).toHaveLength(0);
    expect(
      detectTrialEndings([{ merchant: "Old App", trial_ends_on: "2026-08-01" }], NOW)
    ).toHaveLength(0);
  });

  it("handles a missing plan price honestly", () => {
    const findings = detectTrialEndings(
      [{ merchant: "Mystery App", trial_ends_on: "2026-09-30" }],
      NOW
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].impact_cents).toBe(0);
    expect(findings[0].detail).toContain("We don't know the plan price");
  });
});
