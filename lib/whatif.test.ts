import { describe, expect, it } from "vitest";
import {
  RANGES,
  actionSentence,
  arrivalMonthLabel,
  assessFeasibility,
  clampInput,
  deltaBucket,
  deltaMonths,
  diffInputs,
  effectiveMonthlyInvestmentCents,
  formatDelta,
  formatDuration,
  observedMonthlySurplusCents,
  projectWhatIf,
  resolveSaveInputs,
  resolveTargetCents,
  shareText,
  validateInputs,
  PRESETS,
  type WhatIfInputs,
} from "./whatif";

const DEMO_BASELINE: WhatIfInputs = {
  monthlySpendingCents: 10_000_00,
  portfolioCents: 150_000_00,
  monthlyInvestmentCents: 5_000_00,
  annualReturnPct: 7,
  targetMode: "auto",
  customTargetCents: null,
  investDifference: false,
};

const START = "2026-09-01";

// ---------- acceptance example from the spec ----------

describe("spec acceptance example", () => {
  it("demo baseline reaches $3M in 231 months; +$500/mo reaches it in 221 (10 sooner)", () => {
    const base = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    expect(base.reachable).toBe(true);
    expect(base.months).toBe(231);
    expect(base.targetCents).toBe(3_000_000_00);

    const scen = projectWhatIf(DEMO_BASELINE, { ...DEMO_BASELINE, monthlyInvestmentCents: 5_500_00 }, START);
    expect(scen.reachable).toBe(true);
    expect(scen.months).toBe(221);
    expect(deltaMonths(base, scen)).toBe(10);
  });
});

// ---------- projection basics ----------

describe("projectWhatIf", () => {
  it("identical baseline and scenario produce zero delta", () => {
    const base = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    const scen = projectWhatIf(DEMO_BASELINE, { ...DEMO_BASELINE }, START);
    expect(deltaMonths(base, scen)).toBe(0);
    expect(formatDelta(0)).toBe("About the same");
  });

  it("higher monthly investment cannot increase months to target", () => {
    const base = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    const scen = projectWhatIf(DEMO_BASELINE, { ...DEMO_BASELINE, monthlyInvestmentCents: 8_000_00 }, START);
    expect(scen.months).toBeLessThan(base.months as number);
    expect(deltaMonths(base, scen)).toBeGreaterThan(0);
  });

  it("portfolio at or above target returns zero months", () => {
    const r = projectWhatIf(
      DEMO_BASELINE,
      { ...DEMO_BASELINE, portfolioCents: 3_000_000_00 },
      START
    );
    expect(r.reachable).toBe(true);
    expect(r.months).toBe(0);
    expect(r.arrivalMonth).toBe("2026-09");
  });

  it("zero savings and zero growth is unreachable (no Infinity/NaN leaks)", () => {
    const r = projectWhatIf(
      DEMO_BASELINE,
      { ...DEMO_BASELINE, monthlyInvestmentCents: 0, annualReturnPct: 0 },
      START
    );
    expect(r.reachable).toBe(false);
    expect(r.months).toBeNull();
    expect(r.arrivalMonth).toBeNull();
    expect(arrivalMonthLabel(r.arrivalMonth)).toBe("not on track");
  });

  it("horizon cap prevents infinite loops", () => {
    const r = projectWhatIf(
      DEMO_BASELINE,
      { ...DEMO_BASELINE, monthlyInvestmentCents: 1_00, annualReturnPct: 0 },
      START
    );
    expect(r.reachable).toBe(false);
    expect(r.months).toBeNull();
  });

  it("arrival month is start month plus computed months", () => {
    const r = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, "2026-09-01");
    expect(r.arrivalMonth).toBe("2045-12"); // 231 months from Sep 2026
    expect(arrivalMonthLabel(r.arrivalMonth)).toBe("December 2045");
  });

  it("stamps the calculation version", () => {
    const r = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    expect(r.calculationVersion).toBe("fire-monthly-v1");
  });
});

// ---------- targets ----------

describe("resolveTargetCents", () => {
  it("auto target is 25x annual spending", () => {
    expect(resolveTargetCents(DEMO_BASELINE)).toBe(3_000_000_00);
  });

  it("lower spending reduces the automatic target", () => {
    const lower = { ...DEMO_BASELINE, monthlySpendingCents: 8_000_00 };
    expect(resolveTargetCents(lower)).toBe(2_400_000_00);
  });

  it("custom target overrides until auto is restored", () => {
    const custom = { ...DEMO_BASELINE, targetMode: "custom" as const, customTargetCents: 2_500_000_00 };
    expect(resolveTargetCents(custom)).toBe(2_500_000_00);
    expect(resolveTargetCents({ ...custom, targetMode: "auto" })).toBe(3_000_000_00);
  });
});

// ---------- invest the difference ----------

describe("invest-the-difference linkage", () => {
  it("spending reduction adds exactly to investing when enabled", () => {
    const scen = { ...DEMO_BASELINE, monthlySpendingCents: 9_500_00, investDifference: true };
    expect(effectiveMonthlyInvestmentCents(DEMO_BASELINE, scen)).toBe(5_500_00);
  });

  it("no double counting by default", () => {
    const scen = { ...DEMO_BASELINE, monthlySpendingCents: 9_500_00, investDifference: false };
    expect(effectiveMonthlyInvestmentCents(DEMO_BASELINE, scen)).toBe(5_000_00);
  });

  it("spending increases never reduce investing", () => {
    const scen = { ...DEMO_BASELINE, monthlySpendingCents: 11_000_00, investDifference: true };
    expect(effectiveMonthlyInvestmentCents(DEMO_BASELINE, scen)).toBe(5_000_00);
  });

  it("resolveSaveInputs folds the linked amount into the saved plan", () => {
    const scen = { ...DEMO_BASELINE, monthlySpendingCents: 9_500_00, investDifference: true };
    const saved = resolveSaveInputs(DEMO_BASELINE, scen);
    expect(saved.monthlyInvestmentCents).toBe(5_500_00);
    expect(saved.investDifference).toBe(false);
    // saved plan projects identically to the explored scenario
    const a = projectWhatIf(DEMO_BASELINE, scen, START);
    const b = projectWhatIf(saved, saved, START);
    expect(a.months).toBe(b.months);
  });
});

// ---------- formatting ----------

describe("formatDelta / formatDuration", () => {
  it("zero and null deltas read as about the same", () => {
    expect(formatDelta(0)).toBe("About the same");
    expect(formatDelta(null)).toBe("About the same");
  });

  it("formats months below 24 months", () => {
    expect(formatDelta(10)).toBe("10 months sooner");
    expect(formatDelta(-1)).toBe("1 month later");
  });

  it("formats years and months at 24+", () => {
    expect(formatDelta(26)).toBe("2 years 2 months sooner");
    expect(formatDelta(-14)).toBe("14 months later");
    expect(formatDelta(24)).toBe("2 years sooner");
  });

  it("never exposes NaN or Infinity", () => {
    for (const d of [formatDelta(10), formatDelta(-300), formatDuration(1200)]) {
      expect(d).not.toMatch(/NaN|Infinity/);
    }
  });
});

// ---------- action sentence & share ----------

describe("actionSentence", () => {
  it("names the behavior and both arrival months", () => {
    const base = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    const scenInputs = { ...DEMO_BASELINE, monthlyInvestmentCents: 5_500_00 };
    const scen = projectWhatIf(DEMO_BASELINE, scenInputs, START);
    const s = actionSentence({
      baseline: DEMO_BASELINE,
      scenario: scenInputs,
      baselineArrival: base.arrivalMonth,
      scenarioArrival: scen.arrivalMonth,
      delta: deltaMonths(base, scen),
    });
    expect(s).toContain("Invest $500 more each month");
    expect(s).toContain("December 2045");
    expect(s).toContain("10 months sooner");
  });

  it("states both changes when invest-the-difference is on", () => {
    const scenInputs = { ...DEMO_BASELINE, monthlySpendingCents: 9_500_00, investDifference: true };
    const base = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    const scen = projectWhatIf(DEMO_BASELINE, scenInputs, START);
    const s = actionSentence({
      baseline: DEMO_BASELINE,
      scenario: scenInputs,
      baselineArrival: base.arrivalMonth,
      scenarioArrival: scen.arrivalMonth,
      delta: deltaMonths(base, scen),
    });
    expect(s).toContain("Spend $500 less each month");
    expect(s).toContain("difference toward investing");
  });

  it("handles unreachable scenarios without banned words", () => {
    const scenInputs = { ...DEMO_BASELINE, monthlyInvestmentCents: 0, annualReturnPct: 0 };
    const base = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    const scen = projectWhatIf(DEMO_BASELINE, scenInputs, START);
    const s = actionSentence({
      baseline: DEMO_BASELINE,
      scenario: scenInputs,
      baselineArrival: base.arrivalMonth,
      scenarioArrival: scen.arrivalMonth,
      delta: deltaMonths(base, scen),
    });
    expect(s).toMatch(/does not reach the target/);
    expect(s).not.toMatch(/\b(will|guaranteed|best|recommended)\b/i);
  });

  it("never uses banned words in any sentence", () => {
    const base = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    for (const p of PRESETS) {
      const scenInputs = { ...DEMO_BASELINE, ...p.apply(DEMO_BASELINE) };
      const scen = projectWhatIf(DEMO_BASELINE, scenInputs, START);
      const s = actionSentence({
        baseline: DEMO_BASELINE,
        scenario: scenInputs,
        baselineArrival: base.arrivalMonth,
        scenarioArrival: scen.arrivalMonth,
        delta: deltaMonths(base, scen),
      });
      expect(s).not.toMatch(/\b(will|guaranteed|best|recommended)\b/i);
    }
  });
});

describe("shareText", () => {
  it("excludes portfolio, income, and target by default", () => {
    const base = projectWhatIf(DEMO_BASELINE, DEMO_BASELINE, START);
    const scenInputs = { ...DEMO_BASELINE, monthlyInvestmentCents: 5_500_00 };
    const scen = projectWhatIf(DEMO_BASELINE, scenInputs, START);
    const t = shareText({
      baseline: DEMO_BASELINE,
      scenario: scenInputs,
      baselineArrival: base.arrivalMonth,
      scenarioArrival: scen.arrivalMonth,
      delta: deltaMonths(base, scen),
    });
    expect(t).not.toMatch(/150,?000|3,?000,?000/);
    expect(t).toContain("10 months sooner");
    expect(t).toContain("Illustration, not a guarantee");
  });
});

// ---------- diff ----------

describe("diffInputs", () => {
  it("omits unchanged inputs", () => {
    expect(diffInputs(DEMO_BASELINE, { ...DEMO_BASELINE })).toEqual([]);
  });

  it("lists only what changed", () => {
    const d = diffInputs(DEMO_BASELINE, { ...DEMO_BASELINE, monthlyInvestmentCents: 6_000_00 });
    expect(d.map((x) => x.key)).toEqual(["monthlyInvestmentCents"]);
  });

  it("notes the linked amount on investing", () => {
    const d = diffInputs(DEMO_BASELINE, {
      ...DEMO_BASELINE,
      monthlySpendingCents: 9_500_00,
      investDifference: true,
    });
    const inv = d.find((x) => x.key === "monthlyInvestmentCents");
    expect(inv?.scenarioText).toContain("from spending less");
  });
});

// ---------- presets ----------

describe("PRESETS", () => {
  it("all five launch presets apply within valid ranges", () => {
    expect(PRESETS.map((p) => p.id)).toEqual([
      "invest-250",
      "invest-500",
      "spend-250",
      "spend-500-invest-diff",
      "target-250k",
    ]);
    for (const p of PRESETS) {
      const next = { ...DEMO_BASELINE, ...p.apply(DEMO_BASELINE) };
      expect(validateInputs(next)).toEqual([]);
    }
  });

  it("target preset creates a custom target $250k below auto", () => {
    const next = { ...DEMO_BASELINE, ...PRESETS[4].apply(DEMO_BASELINE) };
    expect(next.targetMode).toBe("custom");
    expect(resolveTargetCents(next)).toBe(2_750_000_00);
  });
});

// ---------- validation ----------

describe("validateInputs / clampInput", () => {
  it("accepts the demo baseline", () => {
    expect(validateInputs(DEMO_BASELINE)).toEqual([]);
  });

  it("flags out-of-range and non-finite values", () => {
    expect(validateInputs({ ...DEMO_BASELINE, monthlyInvestmentCents: -1 })).toContain(
      "monthlyInvestmentCents"
    );
    expect(validateInputs({ ...DEMO_BASELINE, annualReturnPct: NaN })).toContain("annualReturnPct");
    expect(validateInputs({ ...DEMO_BASELINE, annualReturnPct: 99 })).toContain("annualReturnPct");
  });

  it("clamps to ranges and rounds return to 2 decimals", () => {
    expect(clampInput("monthlyInvestmentCents", 99_999_00)).toBe(RANGES.monthlyInvestmentCents.max);
    expect(clampInput("annualReturnPct", 7.126)).toBe(7.13);
    expect(clampInput("monthlySpendingCents", NaN)).toBe(RANGES.monthlySpendingCents.min);
  });
});

// ---------- feasibility ----------

describe("observedMonthlySurplusCents / assessFeasibility", () => {
  const txns = [
    { amount_cents: 1_600_000, kind: "income", posted_at: "2026-07-05" },
    { amount_cents: -900_000, kind: "expense", posted_at: "2026-07-20" },
    { amount_cents: 1_600_000, kind: "income", posted_at: "2026-08-05" },
    { amount_cents: -1_100_000, kind: "expense", posted_at: "2026-08-20" },
    { amount_cents: -50_000, kind: "transfer", posted_at: "2026-08-21" }, // excluded
  ];

  it("averages income minus spending across distinct months", () => {
    // income 3.2M, spending 2.0M over 2 months -> 600k/mo surplus
    expect(observedMonthlySurplusCents(txns)).toBe(600_000);
  });

  it("returns null with no usable history", () => {
    expect(observedMonthlySurplusCents([])).toBeNull();
    expect(assessFeasibility(5_000_00, null)).toEqual({ state: "unknown" });
  });

  it("ok within surplus, note just over, acknowledge past 10%", () => {
    expect(assessFeasibility(500_000, 600_000)).toEqual({ state: "ok" });
    const note = assessFeasibility(650_000, 600_000);
    expect(note.state).toBe("note");
    if (note.state !== "ok" && note.state !== "unknown") expect(note.gapCents).toBe(50_000);
    expect(assessFeasibility(700_000, 600_000).state).toBe("acknowledge");
  });
});

// ---------- analytics buckets ----------

describe("deltaBucket", () => {
  it("buckets without exact values", () => {
    expect(deltaBucket(null)).toBe("same");
    expect(deltaBucket(0)).toBe("same");
    expect(deltaBucket(10)).toBe("7-12m");
    expect(deltaBucket(-30)).toBe("2y+");
  });
});
