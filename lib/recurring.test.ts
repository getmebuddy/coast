import { describe, expect, it } from "vitest";
import {
  detectRecurring,
  monthlyEquivalent,
  nextChargeDate,
  toRecurringUpsertRows,
  totalMonthlyRecurringCents,
  type RecurringInput,
} from "./recurring";
import {
  demoCommittedBillsCents,
  demoMonthlyRecurringCents,
  demoRecurring,
  demoSubscriptions,
  demoTransactions,
} from "./demo";

function charge(merchant: string, date: string, amountCents: number): RecurringInput {
  return { merchant, date, amount_cents: -Math.abs(amountCents), kind: "expense" };
}

function monthlySeries(merchant: string, amounts: number[], startISO = "2026-06-03"): RecurringInput[] {
  return amounts.map((a, i) => {
    const d = new Date(startISO + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + i);
    return charge(merchant, d.toISOString().slice(0, 10), a);
  });
}

// ---------- cadence inference ----------

describe("detectRecurring cadence", () => {
  it("finds a monthly subscription", () => {
    const out = detectRecurring(monthlySeries("Spotify", [1199, 1199, 1199, 1199]));
    expect(out).toHaveLength(1);
    expect(out[0].cadence).toBe("monthly");
    expect(out[0].charges_count).toBe(4);
    expect(out[0].next_charge_date).toBe("2026-10-03");
    expect(out[0].price_changed).toBe(false);
  });

  it("finds a weekly subscription", () => {
    const txns = Array.from({ length: 8 }, (_, i) => {
      const d = new Date("2026-08-04T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i * 7);
      return charge("HelloFresh", d.toISOString().slice(0, 10), 6840);
    });
    const out = detectRecurring(txns);
    expect(out).toHaveLength(1);
    expect(out[0].cadence).toBe("weekly");
    expect(out[0].monthly_cents).toBe(Math.round((6840 * 52) / 12));
  });

  it("finds an annual subscription", () => {
    const txns = ["2024-07-03", "2025-07-03", "2026-07-03"].map((d) =>
      charge("Prime", d, 13900)
    );
    const out = detectRecurring(txns);
    expect(out).toHaveLength(1);
    expect(out[0].cadence).toBe("annual");
    expect(out[0].next_charge_date).toBe("2027-07-03");
    expect(out[0].monthly_cents).toBe(Math.round(13900 / 12));
  });

  it("rejects fewer than 3 charges", () => {
    const out = detectRecurring(monthlySeries("Prime", [13900, 13900]));
    expect(out).toHaveLength(0);
  });

  it("rejects irregular intervals", () => {
    const txns = [
      charge("Random", "2026-06-03", 5000),
      charge("Random", "2026-07-03", 5000),
      charge("Random", "2026-09-03", 5000), // 62-day gap breaks the pattern
      charge("Random", "2026-10-03", 5000),
    ];
    expect(detectRecurring(txns)).toHaveLength(0);
  });

  it("ignores transfers, income, refunds, and pending charges", () => {
    const txns: RecurringInput[] = [
      ...monthlySeries("Chase Transfer", [50000, 50000, 50000]).map((t) => ({
        ...t,
        kind: "transfer",
      })),
      ...monthlySeries("Salary", [425000, 425000, 425000]).map((t) => ({
        ...t,
        kind: "income",
        amount_cents: 425000,
      })),
      ...monthlySeries("Pending Sub", [999, 999, 999]).map((t) => ({ ...t, pending: true })),
    ];
    expect(detectRecurring(txns)).toHaveLength(0);
  });
});

// ---------- price changes ----------

describe("detectRecurring price changes", () => {
  it("flags a hike after a stable history (Netflix case)", () => {
    const out = detectRecurring(monthlySeries("Netflix", [1549, 1799, 1799, 1799]));
    expect(out).toHaveLength(1);
    expect(out[0].price_changed).toBe(true);
    expect(out[0].prev_amount_cents).toBe(1549);
    expect(out[0].amount_cents).toBe(1799);
  });

  it("flags a hike that landed on the most recent charge", () => {
    const out = detectRecurring(monthlySeries("Hulu", [1799, 1799, 1799, 2299]));
    expect(out[0].price_changed).toBe(true);
    expect(out[0].prev_amount_cents).toBe(1799);
  });

  it("stays quiet on variable bills (Xcel case)", () => {
    const out = detectRecurring(monthlySeries("Xcel Energy", [16000, 13600, 12100, 16100]));
    expect(out).toHaveLength(1); // still recurring — cadence is regular
    expect(out[0].price_changed).toBe(false);
    expect(out[0].prev_amount_cents).toBeNull();
  });

  it("stays quiet on flat pricing", () => {
    const out = detectRecurring(monthlySeries("Spotify", [1199, 1199, 1199, 1199]));
    expect(out[0].price_changed).toBe(false);
  });

  it("ignores dust-level differences", () => {
    const out = detectRecurring(monthlySeries("Gym", [4900, 4900, 4900, 4901]));
    expect(out[0].price_changed).toBe(false);
  });
});

// ---------- helpers ----------

describe("recurring helpers", () => {
  it("nextChargeDate clamps short months", () => {
    expect(nextChargeDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextChargeDate("2026-09-15", "weekly")).toBe("2026-09-22");
  });

  it("monthlyEquivalent normalizes cadences", () => {
    expect(monthlyEquivalent(1799, "monthly")).toBe(1799);
    expect(monthlyEquivalent(6840, "weekly")).toBe(Math.round((6840 * 52) / 12));
    expect(monthlyEquivalent(13900, "annual")).toBe(Math.round(13900 / 12));
  });

  it("toRecurringUpsertRows preserves user dismissals", () => {
    const detected = detectRecurring(monthlySeries("Spotify", [1199, 1199, 1199]));
    const dismissed = new Map([["Spotify", true]]);
    const rows = toRecurringUpsertRows("user-1", detected, dismissed, "2026-09-21T00:00:00Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].dismissed).toBe(true);
    expect(rows[0].merchant_normalized).toBe("Spotify");
    expect(rows[0].user_id).toBe("user-1");
    expect(rows[0].price_changed).toBe(false);

    const rows2 = toRecurringUpsertRows("user-1", detected, new Map(), "2026-09-21T00:00:00Z");
    expect(rows2[0].dismissed).toBe(false);
  });
});

// ---------- demo ledger drift guard ----------

describe("detector vs demo seed (drift guard)", () => {
  const inputs: RecurringInput[] = demoTransactions.map((t) => ({
    merchant: t.merchant,
    amount_cents: t.amount_cents,
    date: t.date,
    kind: t.kind,
    pending: t.pending,
  }));
  const detected = detectRecurring(inputs);

  it("detects the same set the seed carries", () => {
    expect(detected.map((d) => d.merchant).sort()).toEqual(
      demoRecurring.map((r) => r.merchant).sort()
    );
  });

  it("every seeded entry matches detector output field-for-field", () => {
    for (const r of demoRecurring) {
      const d = detected.find((x) => x.merchant === r.merchant);
      expect(d, r.merchant).toBeDefined();
      expect(r.cadence).toBe(d!.cadence);
      expect(r.charges_count).toBe(d!.charges_count);
      expect(r.amount_cents_avg).toBe(d!.amount_cents); // seed stores latest as avg
      expect(r.next_charge_date).toBe(d!.next_charge_date);
      expect(r.price_changed).toBe(d!.price_changed);
      expect(r.prev_amount_cents).toBe(d!.prev_amount_cents);
      expect(r.monthly_cents).toBe(d!.monthly_cents);
    }
  });

  it("finds the Netflix hike from the ledger", () => {
    const netflix = detected.find((d) => d.merchant === "Netflix")!;
    expect(netflix.price_changed).toBe(true);
    expect(netflix.prev_amount_cents).toBe(1549);
    expect(netflix.amount_cents).toBe(1799);
  });

  it("finds rent as recurring but not as a subscription", () => {
    const rent = detected.find((d) => d.merchant === "Rent — AMLI")!;
    expect(rent.cadence).toBe("monthly");
    expect(demoSubscriptions.some((s) => s.merchant === "Rent — AMLI")).toBe(false);
  });

  it("totals stay consistent", () => {
    expect(totalMonthlyRecurringCents(detected)).toBe(demoCommittedBillsCents);
    expect(demoMonthlyRecurringCents).toBe(
      demoSubscriptions.reduce((s, r) => s + r.monthly_cents, 0)
    );
    // subscriptions exclude rent
    expect(demoMonthlyRecurringCents).toBe(
      demoCommittedBillsCents - detected.find((d) => d.merchant === "Rent — AMLI")!.monthly_cents
    );
  });
});
