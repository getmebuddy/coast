import { describe, expect, it } from "vitest";
import {
  formatUSD,
  formatUSDCompact,
  monthYear,
  progressPct,
  projectedFire,
  safeToSpendCents,
  targetNumberCents,
} from "./fire";

// ---------- targetNumberCents ----------

describe("targetNumberCents", () => {
  it("target is 25x annual spending", () => {
    expect(targetNumberCents(120_000_00)).toBe(3_000_000_00); // $120k/yr -> $3.0M
  });

  it("target of zero spending is zero", () => {
    expect(targetNumberCents(0)).toBe(0);
  });

  it("rejects negatives and non-integers", () => {
    expect(() => targetNumberCents(-1)).toThrow();
    expect(() => targetNumberCents(10.5)).toThrow();
  });
});

// ---------- projectedFire ----------

describe("projectedFire", () => {
  it("already at the number: 0 months, reachable", () => {
    const r = projectedFire({
      portfolioCents: 3_000_000_00,
      monthlySavingsCents: 5_000_00,
      annualReturnPct: 7,
      targetCents: 3_000_000_00,
      startISO: "2026-09-19",
    });
    expect(r.reachable).toBe(true);
    expect(r.months).toBe(0);
    expect(r.dateISO).toBe("2026-09-19");
  });

  it("no savings and no growth: unreachable, no NaN/Infinity leaks into UI fields", () => {
    const r = projectedFire({
      portfolioCents: 150_000_00,
      monthlySavingsCents: 0,
      annualReturnPct: 0,
      targetCents: 3_000_000_00,
      startISO: "2026-09-19",
    });
    expect(r.reachable).toBe(false);
    expect(r.dateISO).toBeNull();
    expect(Number.isFinite(r.finalPortfolioCents)).toBe(true);
  });

  it("negative savings with no growth: unreachable", () => {
    const r = projectedFire({
      portfolioCents: 150_000_00,
      monthlySavingsCents: -500_00,
      annualReturnPct: 0,
      targetCents: 3_000_000_00,
    });
    expect(r.reachable).toBe(false);
  });

  it("sanity: $150k start, $5k/mo, 7% -> roughly 20 years to $3M", () => {
    const r = projectedFire({
      portfolioCents: 150_000_00,
      monthlySavingsCents: 5_000_00,
      annualReturnPct: 7,
      targetCents: 3_000_000_00,
      startISO: "2026-09-19",
    });
    expect(r.reachable).toBe(true);
    // closed-form check: FV ≈ 150k*1.07^20 + 5k*12*((1.07^20-1)/0.07) ≈ $3.02M
    expect(r.months).toBeGreaterThanOrEqual(230);
    expect(r.months).toBeLessThanOrEqual(250);
    expect(r.dateISO).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("higher savings pulls the date closer (what-if direction)", () => {
    const base = { portfolioCents: 150_000_00, annualReturnPct: 7, targetCents: 3_000_000_00, startISO: "2026-09-19" };
    const a = projectedFire({ ...base, monthlySavingsCents: 5_000_00 });
    const b = projectedFire({ ...base, monthlySavingsCents: 5_500_00 });
    expect(b.months).toBeLessThan(a.months);
  });

  it("lower return pushes the date out (what-if direction)", () => {
    const base = { portfolioCents: 150_000_00, monthlySavingsCents: 5_000_00, targetCents: 3_000_000_00, startISO: "2026-09-19" };
    const a = projectedFire({ ...base, annualReturnPct: 7 });
    const b = projectedFire({ ...base, annualReturnPct: 5 });
    expect(b.months).toBeGreaterThan(a.months);
  });

  it("zero return still works (pure savings math)", () => {
    const r = projectedFire({
      portfolioCents: 0,
      monthlySavingsCents: 10_000_00,
      annualReturnPct: 0,
      targetCents: 1_200_000_00,
      startISO: "2026-09-19",
    });
    expect(r.reachable).toBe(true);
    expect(r.months).toBe(120); // $10k/mo -> $1.2M in exactly 120 months
  });

  it("rejects bad inputs", () => {
    expect(() =>
      projectedFire({ portfolioCents: -1, monthlySavingsCents: 1, annualReturnPct: 7, targetCents: 100 })
    ).toThrow();
    expect(() =>
      projectedFire({ portfolioCents: 0, monthlySavingsCents: 1, annualReturnPct: NaN, targetCents: 100 })
    ).toThrow();
    expect(() =>
      projectedFire({ portfolioCents: 0, monthlySavingsCents: 1, annualReturnPct: 7, targetCents: 0 })
    ).toThrow();
    expect(() =>
      projectedFire({ portfolioCents: 1.5, monthlySavingsCents: 1, annualReturnPct: 7, targetCents: 100 })
    ).toThrow();
  });
});

// ---------- safeToSpendCents ----------

describe("safeToSpendCents", () => {
  it("divides remaining by days left", () => {
    // $16,000 income - $3,200 bills - $6,000 budgeted = $6,800 over 20 days = $340/day
    expect(
      safeToSpendCents({ cycleIncomeCents: 16_000_00, committedBillsCents: 3_200_00, budgetedSpendCents: 6_000_00, daysLeft: 20 })
    ).toBe(340_00);
  });

  it("floors at zero, never negative", () => {
    expect(
      safeToSpendCents({ cycleIncomeCents: 5_000_00, committedBillsCents: 4_000_00, budgetedSpendCents: 3_000_00, daysLeft: 10 })
    ).toBe(0);
  });

  it("rejects daysLeft < 1", () => {
    expect(() =>
      safeToSpendCents({ cycleIncomeCents: 1, committedBillsCents: 0, budgetedSpendCents: 0, daysLeft: 0 })
    ).toThrow();
  });
});

// ---------- formatting ----------

describe("formatting", () => {
  it("formatUSD", () => {
    expect(formatUSD(3140_00)).toBe("$3,140.00");
    expect(formatUSD(-50_00)).toBe("-$50.00");
  });

  it("formatUSDCompact", () => {
    expect(formatUSDCompact(3_000_000_00)).toBe("$3.0M");
    expect(formatUSDCompact(22_500_00)).toBe("$22.5K");
  });

  it("progressPct clamps 0–100", () => {
    expect(progressPct(150_000_00, 3_000_000_00)).toBeCloseTo(5, 6);
    expect(progressPct(0, 3_000_000_00)).toBe(0);
    expect(progressPct(4_000_000_00, 3_000_000_00)).toBe(100);
    expect(progressPct(1, 0)).toBe(0);
  });

  it("monthYear", () => {
    expect(monthYear("2039-06-01")).toBe("June 2039");
    expect(monthYear(null)).toBe("not on track");
  });
});
