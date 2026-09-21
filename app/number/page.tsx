"use client";

/**
 * The Number — your finish line. Editable assumptions, projected date,
 * and what-if sliders that recompute the FIRE date LIVE on every input event.
 */
import { useMemo, useState } from "react";
import { demoFire } from "@/lib/demo";
import {
  formatUSD,
  formatUSDCompact,
  monthYear,
  progressPct,
  projectedFire,
  targetNumberCents,
} from "@/lib/fire";
import TrajectoryRing from "../components/TrajectoryRing";

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">{label}</label>
        <span className="tnum text-[var(--type-body-size)] font-semibold">{display}</span>
      </div>
      <input
        type="range"
        className="whatif"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default function NumberPage() {
  const [annualSpending, setAnnualSpending] = useState(demoFire.annual_spending_cents);
  const [portfolio, setPortfolio] = useState(demoFire.portfolio_cents);
  const [monthlySavings, setMonthlySavings] = useState(demoFire.monthly_savings_cents);
  const [expectedReturn, setExpectedReturn] = useState(demoFire.expected_return_pct);

  // Recompute on EVERY input event — the date moves as the thumb moves.
  const target = useMemo(() => targetNumberCents(annualSpending), [annualSpending]);
  const proj = useMemo(
    () =>
      projectedFire({
        portfolioCents: portfolio,
        monthlySavingsCents: monthlySavings,
        annualReturnPct: expectedReturn,
        targetCents: target,
      }),
    [portfolio, monthlySavings, expectedReturn, target]
  );
  const pct = progressPct(portfolio, target);

  // Saved-plan comparison: the demo baseline vs the current what-if scenario
  const saved = useMemo(
    () =>
      projectedFire({
        portfolioCents: demoFire.portfolio_cents,
        monthlySavingsCents: demoFire.monthly_savings_cents,
        annualReturnPct: demoFire.expected_return_pct,
        targetCents: targetNumberCents(demoFire.annual_spending_cents),
      }),
    []
  );
  const deltaMonths =
    proj.reachable && saved.reachable ? saved.months - proj.months : null;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          The Number
        </h1>
        <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          Your finish line — the amount that makes work optional.
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <TrajectoryRing pct={pct} />
        <p className="tnum text-3xl font-bold text-[var(--text-hero-number)]">
          {formatUSDCompact(target)}
        </p>
        <p className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          25× your annual spending · 4% rule
        </p>
      </div>

      <div className="rounded-xl bg-[var(--surface-card)] p-5 elev-1 text-center">
        {proj.reachable ? (
          <>
            <p className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
              Projected date
            </p>
            <p className="tnum mt-1 text-2xl font-bold text-[var(--text-hero-number)]">
              {monthYear(proj.dateISO)}
            </p>
            <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              {proj.months} months away
            </p>
          </>
        ) : (
          <p className="text-[var(--type-body-size)]">
            Not on track yet — even a small monthly increase moves the date.
          </p>
        )}
        {deltaMonths !== null && deltaMonths !== 0 && (
          <p
            className={`mt-2 rounded-full px-3 py-1 text-[var(--type-caption-size)] font-semibold inline-block ${
              deltaMonths > 0
                ? "bg-[var(--accent-progress-soft)] text-[var(--accent-progress)]"
                : "bg-[var(--signal-warning-soft)] text-[var(--signal-warning)]"
            }`}
          >
            {deltaMonths > 0
              ? `${deltaMonths} months sooner than your saved plan`
              : `${Math.abs(deltaMonths)} months later than your saved plan`}
          </p>
        )}
      </div>

      <div className="rounded-xl bg-[var(--surface-card)] p-5 elev-1 space-y-5">
        <h2 className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          What if…
        </h2>
        <Slider
          label="Annual spending"
          value={annualSpending}
          min={60_000_00}
          max={240_000_00}
          step={5_000_00}
          display={formatUSD(annualSpending) + "/yr"}
          onChange={setAnnualSpending}
        />
        <Slider
          label="Monthly savings"
          value={monthlySavings}
          min={0}
          max={15_000_00}
          step={100_00}
          display={formatUSD(monthlySavings) + "/mo"}
          onChange={setMonthlySavings}
        />
        <Slider
          label="Expected return"
          value={expectedReturn}
          min={0}
          max={12}
          step={0.25}
          display={`${expectedReturn.toFixed(2)}%`}
          onChange={setExpectedReturn}
        />
        <Slider
          label="Current portfolio"
          value={portfolio}
          min={0}
          max={1_000_000_00}
          step={5_000_00}
          display={formatUSD(portfolio)}
          onChange={setPortfolio}
        />
      </div>

      <p className="text-center text-[var(--type-caption-size)] text-[var(--text-secondary)]">
        Heard of FIRE? That's this. Drag a slider — the date moves with your thumb.
      </p>
    </div>
  );
}
