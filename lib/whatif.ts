/**
 * What-If Planner domain logic — pure functions, unit-tested.
 *
 * Deterministic monthly-compounding projections built on the FIRE engine.
 * Educational illustrations only: this module never recommends securities,
 * never places trades, and never personalizes advice.
 *
 * Money is ALWAYS integer cents. No floats cross a function boundary
 * except annualReturnPct, which is validated and kept to 2 decimals.
 */
import { monthYear, projectedFire, targetNumberCents } from "./fire";

/** Formula identity stamped on every saved plan and scenario result. */
export const CALCULATION_VERSION = "fire-monthly-v1";
/** Model horizon: 100 years of months. Beyond this we say "not on track". */
export const CALCULATION_HORIZON_MONTHS = 1200;

export type TargetMode = "auto" | "custom";

export interface WhatIfInputs {
  /** monthly spending, integer cents */
  monthlySpendingCents: number;
  /** current invested portfolio, integer cents */
  portfolioCents: number;
  /** monthly amount invested, integer cents (before any linked difference) */
  monthlyInvestmentCents: number;
  /** expected nominal annual return, e.g. 7 for 7% */
  annualReturnPct: number;
  /** "auto" = 25x annual spending; "custom" = user override */
  targetMode: TargetMode;
  /** required when targetMode is "custom" */
  customTargetCents: number | null;
  /** when true, spending reductions vs baseline flow into investing */
  investDifference: boolean;
}

export interface ScenarioProjection {
  reachable: boolean;
  /** months to target; null when unreachable */
  months: number | null;
  /** arrival as "YYYY-MM"; null when unreachable */
  arrivalMonth: string | null;
  /** resolved target in cents */
  targetCents: number;
  /** monthly investing actually modeled (after any linked difference) */
  effectiveMonthlyInvestmentCents: number;
  calculationVersion: string;
}

export interface ChangedInput {
  key: string;
  label: string;
  baselineText: string;
  scenarioText: string;
}

/** Control ranges and steps (FR-07 through FR-11). */
export const RANGES = {
  monthlySpendingCents: { min: 1_000_00, max: 30_000_00, step: 50_00, label: "Monthly spending" },
  monthlyInvestmentCents: { min: 0, max: 25_000_00, step: 50_00, label: "Monthly investing" },
  annualReturnPct: { min: 0, max: 12, step: 0.25, label: "Expected return" },
  portfolioCents: { min: 0, max: 20_000_000_00, step: 1_000_00, label: "Current portfolio" },
  customTargetCents: { min: 100_000_00, max: 50_000_000_00, step: 10_000_00, label: "Target amount" },
} as const;

export type InputKey = keyof typeof RANGES;

function assertCents(v: number, name: string): void {
  if (!Number.isInteger(v)) throw new Error(`${name} must be integer cents`);
}

/** Resolve the target: custom override, or 25x annualized monthly spending. */
export function resolveTargetCents(inputs: WhatIfInputs): number {
  assertCents(inputs.monthlySpendingCents, "monthlySpendingCents");
  if (inputs.targetMode === "custom") {
    if (inputs.customTargetCents == null) throw new Error("customTargetCents required in custom mode");
    assertCents(inputs.customTargetCents, "customTargetCents");
    if (inputs.customTargetCents <= 0) throw new Error("customTargetCents must be > 0");
    return inputs.customTargetCents;
  }
  return targetNumberCents(inputs.monthlySpendingCents * 12);
}

/**
 * Monthly investing actually modeled. When "invest the difference" is on,
 * a spending reduction vs the baseline is added to investing. Spending
 * increases never reduce investing (linkage delta clamped at zero).
 */
export function effectiveMonthlyInvestmentCents(
  baseline: WhatIfInputs,
  scenario: WhatIfInputs
): number {
  assertCents(baseline.monthlySpendingCents, "baseline.monthlySpendingCents");
  assertCents(scenario.monthlySpendingCents, "scenario.monthlySpendingCents");
  assertCents(scenario.monthlyInvestmentCents, "scenario.monthlyInvestmentCents");
  const linked = scenario.investDifference
    ? Math.max(0, baseline.monthlySpendingCents - scenario.monthlySpendingCents)
    : 0;
  return scenario.monthlyInvestmentCents + linked;
}

/**
 * Project a scenario against a baseline. The baseline result is the
 * scenario projected against itself (linkage delta is zero).
 */
export function projectWhatIf(
  baseline: WhatIfInputs,
  scenario: WhatIfInputs,
  startISO?: string
): ScenarioProjection {
  const targetCents = resolveTargetCents(scenario);
  const effective = effectiveMonthlyInvestmentCents(baseline, scenario);
  const r = projectedFire({
    portfolioCents: scenario.portfolioCents,
    monthlySavingsCents: effective,
    annualReturnPct: scenario.annualReturnPct,
    targetCents,
    startISO,
  });
  return {
    reachable: r.reachable,
    months: r.reachable ? r.months : null,
    arrivalMonth: r.dateISO ? r.dateISO.slice(0, 7) : null,
    targetCents,
    effectiveMonthlyInvestmentCents: effective,
    calculationVersion: CALCULATION_VERSION,
  };
}

/** Positive = scenario arrives sooner (months saved vs baseline). */
export function deltaMonths(
  baseline: ScenarioProjection,
  scenario: ScenarioProjection
): number | null {
  if (!baseline.reachable || !scenario.reachable) return null;
  return (baseline.months as number) - (scenario.months as number);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "10 months", "1 year 2 months" — no false day-level precision. */
export function formatDuration(months: number): string {
  const m = Math.round(Math.abs(months));
  if (m < 24) return plural(m, "month");
  const y = Math.floor(m / 12);
  const rem = m % 12;
  return rem === 0 ? plural(y, "year") : `${plural(y, "year")} ${plural(rem, "month")}`;
}

/** Delta copy: sooner / later / about the same. Never "0 months sooner". */
export function formatDelta(delta: number | null): string {
  if (delta === null || delta === 0) return "About the same";
  if (delta > 0) return `${formatDuration(delta)} sooner`;
  return `${formatDuration(delta)} later`;
}

/** "2039-06" -> "June 2039". Unreachable -> "not on track". */
export function arrivalMonthLabel(arrivalMonth: string | null): string {
  if (!arrivalMonth) return "not on track";
  return monthYear(`${arrivalMonth}-01`);
}

/** Compact dollars for action sentences, e.g. 500_00 -> "$500". */
function shortUSD(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/**
 * One plain-English decision sentence. Names the changed behavior and both
 * arrival months. Never uses "will", "guaranteed", "best", or "recommended".
 */
export function actionSentence(args: {
  baseline: WhatIfInputs;
  scenario: WhatIfInputs;
  baselineArrival: string | null;
  scenarioArrival: string | null;
  delta: number | null;
}): string {
  const { baseline, scenario, baselineArrival, scenarioArrival, delta } = args;
  const baseLabel = arrivalMonthLabel(baselineArrival);
  const scenLabel = arrivalMonthLabel(scenarioArrival);

  const behaviors: string[] = [];
  const spendDelta = baseline.monthlySpendingCents - scenario.monthlySpendingCents;
  const investDelta = scenario.monthlyInvestmentCents - baseline.monthlyInvestmentCents;
  if (spendDelta !== 0) {
    behaviors.push(
      spendDelta > 0
        ? `Spend ${shortUSD(spendDelta)} less each month`
        : `Spend ${shortUSD(-spendDelta)} more each month`
    );
  }
  if (investDelta !== 0) {
    behaviors.push(
      investDelta > 0
        ? `Invest ${shortUSD(investDelta)} more each month`
        : `Invest ${shortUSD(-investDelta)} less each month`
    );
  }
  if (scenario.investDifference && !baseline.investDifference && spendDelta > 0) {
    behaviors.push(`put the ${shortUSD(spendDelta)} difference toward investing`);
  }
  const baseTarget = resolveTargetCents(baseline);
  const scenTarget = resolveTargetCents(scenario);
  if (scenTarget !== baseTarget) {
    behaviors.push(
      scenTarget < baseTarget
        ? `Lower the target to ${shortUSD(scenTarget)}`
        : `Raise the target to ${shortUSD(scenTarget)}`
    );
  }
  if (scenario.annualReturnPct !== baseline.annualReturnPct) {
    behaviors.push(`Assume a ${scenario.annualReturnPct.toFixed(2)}% return`);
  }
  if (scenario.portfolioCents !== baseline.portfolioCents) {
    behaviors.push(`Start from ${shortUSD(scenario.portfolioCents)}`);
  }

  const behavior = behaviors.length > 0 ? behaviors.join(", ").replace(/, ([^,]*)$/, " and $1") : "Keep everything the same";

  if (delta === null) {
    return `${behavior} — under these assumptions the projection does not reach the target within the model horizon.`;
  }
  if (delta === 0) {
    return `${behavior} — the projected arrival stays around ${baseLabel}.`;
  }
  return `${behavior} and the projected arrival moves from ${baseLabel} to ${scenLabel} (${formatDelta(delta)} than the saved plan).`;
}

/**
 * Shareable summary: behavior and time delta only. Portfolio, income,
 * target, and account data are never included.
 */
export function shareText(args: {
  baseline: WhatIfInputs;
  scenario: WhatIfInputs;
  baselineArrival: string | null;
  scenarioArrival: string | null;
  delta: number | null;
}): string {
  const sentence = actionSentence(args);
  // Lowercase the leading behavior for sentence flow, keep it free of balances.
  const flow = sentence.charAt(0).toLowerCase() + sentence.slice(1);
  return `What if I ${flow} Illustration, not a guarantee. — Coast`;
}

/** Changed inputs only, for the Saved plan vs This scenario comparison. */
export function diffInputs(baseline: WhatIfInputs, scenario: WhatIfInputs): ChangedInput[] {
  const out: ChangedInput[] = [];
  const money = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}/mo`;
  if (scenario.monthlySpendingCents !== baseline.monthlySpendingCents) {
    out.push({
      key: "monthlySpendingCents",
      label: "Monthly spending",
      baselineText: money(baseline.monthlySpendingCents),
      scenarioText: money(scenario.monthlySpendingCents),
    });
  }
  const baseEff = effectiveMonthlyInvestmentCents(baseline, baseline);
  const scenEff = effectiveMonthlyInvestmentCents(baseline, scenario);
  if (scenEff !== baseEff || scenario.investDifference !== baseline.investDifference) {
    const linked = scenario.investDifference
      ? Math.max(0, baseline.monthlySpendingCents - scenario.monthlySpendingCents)
      : 0;
    out.push({
      key: "monthlyInvestmentCents",
      label: "Monthly investing",
      baselineText: money(baseEff),
      scenarioText:
        money(scenEff) + (linked > 0 ? ` (includes ${money(linked)} from spending less)` : ""),
    });
  }
  const baseTarget = resolveTargetCents(baseline);
  const scenTarget = resolveTargetCents(scenario);
  if (scenTarget !== baseTarget) {
    const fmt = (c: number) =>
      `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    out.push({
      key: "target",
      label: "Target",
      baselineText: `${fmt(baseTarget)}${baseline.targetMode === "auto" ? " (25× spending)" : ""}`,
      scenarioText: `${fmt(scenTarget)}${scenario.targetMode === "auto" ? " (25× spending)" : " (custom)"}`,
    });
  }
  if (scenario.annualReturnPct !== baseline.annualReturnPct) {
    out.push({
      key: "annualReturnPct",
      label: "Expected return",
      baselineText: `${baseline.annualReturnPct.toFixed(2)}%`,
      scenarioText: `${scenario.annualReturnPct.toFixed(2)}%`,
    });
  }
  if (scenario.portfolioCents !== baseline.portfolioCents) {
    const fmt = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
    out.push({
      key: "portfolioCents",
      label: "Current portfolio",
      baselineText: fmt(baseline.portfolioCents),
      scenarioText: fmt(scenario.portfolioCents),
    });
  }
  return out;
}

/**
 * Fold a draft scenario into persistable plan inputs: any linked difference
 * becomes part of monthly investing and the flag resets, so the saved plan
 * is unambiguous.
 */
export function resolveSaveInputs(baseline: WhatIfInputs, scenario: WhatIfInputs): WhatIfInputs {
  return {
    ...scenario,
    monthlyInvestmentCents: effectiveMonthlyInvestmentCents(baseline, scenario),
    investDifference: false,
  };
}

/** Clamp a control value to its valid range. */
export function clampInput(key: InputKey, value: number): number {
  const r = RANGES[key];
  if (!Number.isFinite(value)) return r.min;
  if (key === "annualReturnPct") {
    return Math.min(r.max, Math.max(r.min, Math.round(value * 100) / 100));
  }
  return Math.min(r.max, Math.max(r.min, Math.round(value)));
}

/** Field keys failing validation (empty = valid). Server and client share this. */
export function validateInputs(inputs: WhatIfInputs): string[] {
  const bad: string[] = [];
  try {
    for (const key of Object.keys(RANGES) as InputKey[]) {
      if (key === "customTargetCents" && inputs.targetMode !== "custom") continue;
      const v = inputs[key];
      if (v == null || !Number.isFinite(v as number)) {
        bad.push(key);
        continue;
      }
      const r = RANGES[key];
      if ((v as number) < r.min || (v as number) > r.max) bad.push(key);
    }
    if (inputs.targetMode !== "auto" && inputs.targetMode !== "custom") bad.push("targetMode");
    if (typeof inputs.investDifference !== "boolean") bad.push("investDifference");
    resolveTargetCents(inputs);
    effectiveMonthlyInvestmentCents(inputs, inputs);
  } catch {
    if (!bad.includes("target")) bad.push("target");
  }
  return [...new Set(bad)];
}

// ---------- presets ----------

export interface PresetDef {
  id: string;
  label: string;
  apply: (baseline: WhatIfInputs) => Partial<WhatIfInputs>;
}

/** Launch presets: shortcuts around the baseline, clamped to valid ranges. */
export const PRESETS: PresetDef[] = [
  {
    id: "invest-250",
    label: "Invest $250 more",
    apply: (b) => ({
      monthlyInvestmentCents: clampInput("monthlyInvestmentCents", b.monthlyInvestmentCents + 250_00),
    }),
  },
  {
    id: "invest-500",
    label: "Invest $500 more",
    apply: (b) => ({
      monthlyInvestmentCents: clampInput("monthlyInvestmentCents", b.monthlyInvestmentCents + 500_00),
    }),
  },
  {
    id: "spend-250",
    label: "Spend $250 less",
    apply: (b) => ({
      monthlySpendingCents: clampInput("monthlySpendingCents", b.monthlySpendingCents - 250_00),
    }),
  },
  {
    id: "spend-500-invest-diff",
    label: "Spend $500 less, invest it",
    apply: (b) => ({
      monthlySpendingCents: clampInput("monthlySpendingCents", b.monthlySpendingCents - 500_00),
      investDifference: true,
    }),
  },
  {
    id: "target-250k",
    label: "Target $250k less",
    apply: (b) => ({
      targetMode: "custom" as TargetMode,
      customTargetCents: clampInput(
        "customTargetCents",
        resolveTargetCents(b) - 250_000_00
      ),
    }),
  },
];

// ---------- feasibility ----------

export interface LedgerTxn {
  amount_cents: number;
  kind: string;
  posted_at: string; // YYYY-MM-DD
  pending?: boolean;
}

/**
 * Observed monthly surplus from ledger history: average monthly income
 * minus average monthly spending, across distinct months present.
 * Returns null when there is no usable history.
 */
export function observedMonthlySurplusCents(txns: LedgerTxn[]): number | null {
  const months = new Set<string>();
  let income = 0;
  let spending = 0;
  for (const t of txns) {
    if (t.pending) continue;
    if (t.kind !== "income" && t.kind !== "expense" && t.kind !== "fee") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.posted_at)) continue;
    months.add(t.posted_at.slice(0, 7));
    if (t.kind === "income") income += Math.max(0, t.amount_cents);
    else spending += Math.abs(t.amount_cents);
  }
  if (months.size === 0) return null;
  return Math.round((income - spending) / months.size);
}

export type Feasibility = { state: "ok" } | { state: "unknown" } | { state: "note"; gapCents: number } | { state: "acknowledge"; gapCents: number };

/**
 * FR-14: neutral feasibility signal when the scenario invests more than the
 * observed surplus. Saving needs explicit acknowledgement past a 10% gap.
 */
export function assessFeasibility(
  effectiveMonthlyInvestmentCents: number,
  observedSurplusCents: number | null
): Feasibility {
  if (observedSurplusCents === null) return { state: "unknown" };
  const gap = effectiveMonthlyInvestmentCents - observedSurplusCents;
  if (gap <= 0) return { state: "ok" };
  if (gap > 0.1 * Math.max(0, observedSurplusCents)) return { state: "acknowledge", gapCents: gap };
  return { state: "note", gapCents: gap };
}

// ---------- analytics buckets (never raw values) ----------

export function deltaBucket(delta: number | null): string {
  if (delta === null || delta === 0) return "same";
  const m = Math.abs(delta);
  if (m <= 6) return "1-6m";
  if (m <= 12) return "7-12m";
  if (m <= 24) return "1-2y";
  return "2y+";
}

export function gapBucket(gapCents: number, surplusCents: number): string {
  if (surplusCents <= 0) return "no-surplus";
  const r = gapCents / surplusCents;
  if (r <= 0.1) return "0-10pct";
  if (r <= 0.25) return "10-25pct";
  return "25pct-plus";
}

/**
 * Observed monthly surplus from the seeded demo ledger.
 * Import from lib (never from a client component module).
 */
export function demoSurplus(txns: LedgerTxn[]): number | null {
  return observedMonthlySurplusCents(txns);
}
