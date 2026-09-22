/**
 * Home — the one screen that answers: "Am I closer to my number?"
 * Hero: TrajectoryRing (% of the way) + safe-to-spend + subscription reveal.
 */
import HeroNumber from "./components/HeroNumber";
import TrajectoryRing from "./components/TrajectoryRing";
import CountUp from "./components/CountUp";
import ConnectBank from "./components/ConnectBank";
import { demoCommittedBillsCents, demoFire, demoMonthlyRecurringCents, demoSubscriptions } from "@/lib/demo";
import { monthYear, progressPct, projectedFire, safeToSpendCents, targetNumberCents, formatUSD } from "@/lib/fire";

export default function Home() {
  const target = targetNumberCents(demoFire.annual_spending_cents);
  const pct = progressPct(demoFire.portfolio_cents, target);
  const proj = projectedFire({
    portfolioCents: demoFire.portfolio_cents,
    monthlySavingsCents: demoFire.monthly_savings_cents,
    annualReturnPct: demoFire.expected_return_pct,
    targetCents: target,
  });

  // Safe-to-spend: derive a daily number from the demo month.
  // Committed bills = ALL recurring charges (rent included — it's the
  // biggest committed outflow, excluding it would overstate what's safe).
  const sts = safeToSpendCents({
    cycleIncomeCents: 16_000_00,
    committedBillsCents: demoCommittedBillsCents,
    budgetedSpendCents: 10_000_00,
    daysLeft: 11,
  });

  const subCount = demoSubscriptions.length;

  return (
    <div className="space-y-8">
      <section aria-label="Trajectory" className="flex flex-col items-center gap-4 pt-2">
        <TrajectoryRing pct={pct} />
        <div className="text-center">
          <p className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
            The Number
          </p>
          <p className="tnum mt-1 text-2xl font-bold text-[var(--text-hero-number)]">
            {formatUSD(target)}
          </p>
          <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            {proj.reachable
              ? `On track for ${monthYear(proj.dateISO)} — ${proj.months} months out`
              : "Not on track yet — your plan needs a nudge"}
          </p>
        </div>
      </section>

      <section
        aria-label="Safe to spend"
        className="rounded-xl bg-[var(--surface-card)] p-5 elev-1"
      >
        <p className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          Safe to spend today
        </p>
        <CountUp cents={sts} className="mt-1 block text-4xl font-bold text-[var(--text-hero-number)]" />
        <p className="mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          Income minus committed bills minus your budget, split over the days left.
        </p>
      </section>

      <section
        aria-label="Subscriptions"
        className="rounded-xl bg-[var(--surface-card)] p-5 elev-1"
      >
        <p className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          Subscription reveal
        </p>
        <p className="mt-2 text-[var(--type-body-size)] text-[var(--text-primary)]">
          We found{" "}
          <CountUp cents={demoMonthlyRecurringCents} className="font-bold text-[var(--accent-progress)]" />{" "}
          in <span className="font-bold">{subCount}</span> subscriptions.
        </p>
        <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          One price went up this month — see the Brief for the details.
        </p>
      </section>

      <section aria-label="Demo note" className="space-y-4">
        <HeroNumber
          cents={demoFire.portfolio_cents}
          label="Portfolio"
          sub="Demo mode — connect your bank to see your real trajectory."
        />
        <ConnectBank />
      </section>
    </div>
  );
}
