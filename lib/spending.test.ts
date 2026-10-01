/**
 * Tests for the spending explorer aggregation — pure, ledger-driven.
 * Money: integer cents. Dates: YYYY-MM-DD.
 */
import { describe, expect, it } from "vitest";
import {
  buildCategoriesForWindow,
  buildDonutData,
  buildSpendingData,
  findBucket,
  finishLineLine,
  netIncomeLine,
  summarizeMonth,
  type SpendTxn,
} from "./spending";

function txn(partial: Partial<SpendTxn> & { id: string }): SpendTxn {
  return {
    merchant: "Test Merchant",
    date: "2026-09-10",
    amount_cents: -1000,
    kind: "expense",
    ...partial,
  };
}

const TODAY = "2026-09-27"; // a Sunday

describe("buildSpendingData", () => {
  it("builds 8 week / 6 month / 4 quarter / 5 year buckets", () => {
    const d = buildSpendingData([], TODAY, null);
    expect(d.ranges.week.buckets).toHaveLength(8);
    expect(d.ranges.month.buckets).toHaveLength(6);
    expect(d.ranges.quarter.buckets).toHaveLength(4);
    expect(d.ranges.year.buckets).toHaveLength(5);
  });

  it("separates income from spend and excludes transfers, refunds, pending", () => {
    const txns = [
      txn({ id: "pay", kind: "income", amount_cents: 500000, date: "2026-09-15" }),
      txn({ id: "gro", kind: "expense", amount_cents: -8000, date: "2026-09-16", category: "Groceries" }),
      txn({ id: "fee", kind: "fee", amount_cents: -500, date: "2026-09-17", category: "Fees" }),
      txn({ id: "xfer", kind: "transfer", amount_cents: -20000, date: "2026-09-18" }),
      txn({ id: "ref", kind: "refund", amount_cents: 3000, date: "2026-09-19" }),
      txn({ id: "pend", kind: "expense", amount_cents: -9999, date: "2026-09-20", pending: true }),
    ];
    const d = buildSpendingData(txns, TODAY, null);
    const month = d.ranges.month;
    expect(month.totalIncomeCents).toBe(500000);
    expect(month.totalSpendCents).toBe(8500); // fees count as spending
    expect(month.netIncomeCents).toBe(500000 - 8500);
    const cats = month.categories.map((c) => c.category);
    expect(cats).toContain("Groceries");
    expect(cats).toContain("Fees");
    expect(month.categories.find((c) => c.category === "Groceries")!.spendCents).toBe(8000);
  });

  it("drill-down lists biggest transactions first, capped at 6", () => {
    const txns = Array.from({ length: 8 }, (_, i) =>
      txn({
        id: `t${i}`,
        kind: "expense",
        amount_cents: -(1000 + i * 100),
        date: "2026-09-05",
        category: "Dining",
      })
    );
    const d = buildSpendingData(txns, TODAY, null);
    const dining = d.ranges.month.categories.find((c) => c.category === "Dining")!;
    expect(dining.txnCount).toBe(8);
    expect(dining.top).toHaveLength(6);
    expect(dining.top[0].amountCents).toBe(-1700);
  });

  it("labels uncategorized spend and sorts categories by spend desc", () => {
    const txns = [
      txn({ id: "a", amount_cents: -100, date: "2026-09-05", category: "A" }),
      txn({ id: "b", amount_cents: -900, date: "2026-09-05" }),
    ];
    const d = buildSpendingData(txns, TODAY, null);
    expect(d.ranges.month.categories[0].category).toBe("Uncategorized");
    expect(d.ranges.month.categories[1].category).toBe("A");
  });

  it("scales the finish-line marker per range", () => {
    const d = buildSpendingData([], TODAY, 1_000_000); // $10k/mo
    expect(d.finishLineMonthlyCents).toBe(1_000_000);
    expect(d.ranges.month.finishLinePerBucketCents).toBe(1_000_000);
    expect(d.ranges.quarter.finishLinePerBucketCents).toBe(3_000_000);
    expect(d.ranges.year.finishLinePerBucketCents).toBe(12_000_000);
    expect(d.ranges.week.finishLinePerBucketCents).toBe(Math.round(1_000_000 * (7 / 30.4375)));
  });

  it("returns null finish-line markers when FIRE settings are missing", () => {
    const d = buildSpendingData([], TODAY, null);
    expect(d.finishLineMonthlyCents).toBeNull();
    expect(d.ranges.month.finishLinePerBucketCents).toBeNull();
  });

  it("buckets weeks Monday through Sunday with the current partial week last", () => {
    const txns = [
      txn({ id: "mon", amount_cents: -100, date: "2026-09-21" }), // Monday
      txn({ id: "sun", amount_cents: -200, date: "2026-09-27" }), // Sunday (today)
      txn({ id: "prev", amount_cents: -300, date: "2026-09-20" }), // prior Sunday
    ];
    const d = buildSpendingData(txns, TODAY, null);
    const last = d.ranges.week.buckets[d.ranges.week.buckets.length - 1];
    expect(last.start).toBe("2026-09-21");
    expect(last.end).toBe("2026-09-27");
    expect(last.spendCents).toBe(300);
    const prev = d.ranges.week.buckets[d.ranges.week.buckets.length - 2];
    expect(prev.spendCents).toBe(300);
  });

  it("quarters land on calendar boundaries", () => {
    const d = buildSpendingData([], TODAY, null);
    const qs = d.ranges.quarter.buckets;
    expect(qs[qs.length - 1].key).toBe("2026-Q3");
    expect(qs[qs.length - 1].start).toBe("2026-07-01");
    expect(qs[0].key).toBe("2025-Q4");
  });
});

describe("merchant logos", () => {
  it("carries logoUrl through category drill-down top rows", () => {
    const txns = [
      txn({
        id: "with-logo",
        merchant: "Netflix",
        date: "2026-09-10",
        amount_cents: -1799,
        kind: "expense",
        category: "Entertainment",
        logoUrl: "https://plaid.com/netflix.png",
      }),
      txn({
        id: "no-logo",
        merchant: "Corner Store",
        date: "2026-09-11",
        amount_cents: -500,
        kind: "expense",
        category: "Entertainment",
        logoUrl: null,
      }),
    ];
    const d = buildSpendingData(txns, TODAY, null);
    const cat = d.ranges.month.categories.find((c) => c.category === "Entertainment")!;
    expect(cat.top[0]).toMatchObject({
      merchant: "Netflix",
      logoUrl: "https://plaid.com/netflix.png",
    });
    expect(cat.top[1]).toMatchObject({ merchant: "Corner Store", logoUrl: null });
  });
});

describe("netIncomeLine", () => {
  it("reports overspend as a percentage over earnings", () => {
    expect(netIncomeLine(100000, 137000)).toBe("You spent 37% more than you earned.");
  });
  it("reports savings as a kept percentage", () => {
    expect(netIncomeLine(100000, 78000)).toBe("You kept 22% of what you earned.");
  });
  it("handles zero spend as keeping everything", () => {
    expect(netIncomeLine(100000, 0)).toBe("You kept 100% of what you earned.");
  });
  it("returns null when there is no income to compare against", () => {
    expect(netIncomeLine(0, 50000)).toBeNull();
    expect(netIncomeLine(0, 0)).toBeNull();
  });
});

describe("finishLineLine", () => {
  it("reports over and under in whole dollars", () => {
    expect(finishLineLine(604000, 1000000)).toBe(
      "Your finish-line pace is $10,000/mo — you spent $6,040, $3,960 under."
    );
    expect(finishLineLine(1200000, 1000000)).toBe(
      "Your finish-line pace is $10,000/mo — you spent $12,000, $2,000 over."
    );
  });
  it("names right-on-pace explicitly", () => {
    expect(finishLineLine(1000000, 1000000)).toContain("right on pace");
  });
});

describe("buildDonutData", () => {
  const cats = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ category: `Cat${i}`, spendCents: 1000 * (n - i) }));
  it("keeps the top 8 and rolls the rest into Other", () => {
    const segs = buildDonutData(cats(10), 55000);
    expect(segs).toHaveLength(9);
    expect(segs[8].category).toBe("Other");
    expect(segs[8].colorIndex).toBe(0);
    expect(segs[0].colorIndex).toBe(1);
    expect(segs[7].colorIndex).toBe(8);
  });
  it("percentages sum to ~100", () => {
    const segs = buildDonutData(cats(10), 55000);
    const total = segs.reduce((s, g) => s + g.pct, 0);
    expect(total).toBeCloseTo(100, 8);
  });
  it("returns [] for an empty period", () => {
    expect(buildDonutData([], 0)).toEqual([]);
  });
  it("skips the Other rollup when everything fits", () => {
    const segs = buildDonutData(cats(3), 6000);
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.category !== "Other")).toBe(true);
  });
});

describe("buildCategoriesForWindow", () => {
  it("restricts to the window and caps top rows at 6", () => {
    const txns = [
      ...Array.from({ length: 8 }, (_, i) =>
        txn({ id: `d${i}`, date: "2026-08-05", amount_cents: -(1000 + i * 100), category: "Dining" })
      ),
      txn({ id: "sep", date: "2026-09-05", amount_cents: -5000, category: "Dining" }),
    ];
    const cats = buildCategoriesForWindow(txns, "2026-08-01", "2026-08-31");
    expect(cats).toHaveLength(1);
    expect(cats[0].spendCents).toBe(10800);
    expect(cats[0].top).toHaveLength(6);
    expect(cats[0].top[0].amountCents).toBe(-1700);
  });
  it("matches the latest-bucket breakdown shape from buildSpendingData", () => {
    const txns = [txn({ id: "a", date: "2026-09-10", amount_cents: -2500, category: "Groceries" })];
    const d = buildSpendingData(txns, TODAY, null);
    const viaWindow = buildCategoriesForWindow(txns, "2026-09-01", "2026-09-27");
    expect(viaWindow).toEqual(d.ranges.month.categories);
  });
});

describe("per-bucket category totals", () => {
  it("carries totals for historical buckets too", () => {
    const txns = [
      txn({ id: "aug", date: "2026-08-10", amount_cents: -3000, category: "Groceries" }),
      txn({ id: "sep", date: "2026-09-10", amount_cents: -1000, category: "Groceries" }),
    ];
    const d = buildSpendingData(txns, TODAY, null);
    const aug = d.ranges.month.buckets.find((b) => b.key === "2026-08")!;
    expect(aug.spendCents).toBe(3000);
    expect(aug.categoryTotals).toEqual([
      { category: "Groceries", spendCents: 3000, txnCount: 1 },
    ]);
  });
});

describe("findBucket", () => {
  it("finds a bucket by key across ranges", () => {
    const d = buildSpendingData([], TODAY, null);
    const found = findBucket(d, "2026-08");
    expect(found?.range).toBe("month");
    expect(found?.bucket.key).toBe("2026-08");
    expect(findBucket(d, "2026-Q2")?.range).toBe("quarter");
  });
  it("rejects unknown or malformed keys", () => {
    const d = buildSpendingData([], TODAY, null);
    expect(findBucket(d, "2026-13")).toBeNull();
    expect(findBucket(d, "../../etc")).toBeNull();
    expect(findBucket(d, "x".repeat(30))).toBeNull();
  });
});

describe("summarizeMonth", () => {
  const txns = [
    txn({ id: "pay", kind: "income", amount_cents: 500000, date: "2026-08-15" }),
    txn({ id: "gro", kind: "expense", amount_cents: -8000, date: "2026-08-16", category: "Groceries" }),
    txn({ id: "din", kind: "expense", amount_cents: -12000, date: "2026-08-17", category: "Dining" }),
    txn({ id: "xfer", kind: "transfer", amount_cents: -20000, date: "2026-08-18" }),
    txn({ id: "sep", kind: "expense", amount_cents: -9999, date: "2026-09-01", category: "Dining" }),
  ];
  it("summarizes one month: income, spend, net, categories, biggest", () => {
    const s = summarizeMonth(txns, "2026-08");
    expect(s.monthKey).toBe("2026-08");
    expect(s.monthLabel).toBe("August");
    expect(s.incomeCents).toBe(500000);
    expect(s.spendCents).toBe(20000);
    expect(s.netCents).toBe(480000);
    expect(s.txnCount).toBe(3); // income + 2 expenses; transfer excluded
    expect(s.categories.map((c) => c.category)).toEqual(["Dining", "Groceries"]);
    expect(s.biggestTxn).toMatchObject({ merchant: "Test Merchant", date: "2026-08-17", amountCents: 12000 });
  });
  it("reports zero transactions for an empty month", () => {
    const s = summarizeMonth(txns, "2026-07");
    expect(s.txnCount).toBe(0);
    expect(s.categories).toEqual([]);
    expect(s.biggestTxn).toBeNull();
  });
});
