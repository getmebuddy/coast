"use client";

/**
 * Budgets — monthly ceiling + per-category limits with pace.
 * Tapping a category drills into that month's transactions, biggest first.
 */
import { useMemo, useState } from "react";
import { categoryDrilldown, demoBudgets, demoTransactions } from "@/lib/demo";
import { formatUSD } from "@/lib/fire";

function PaceBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = Math.min(100, (spent / limit) * 100);
  const over = spent > limit;
  return (
    <div className="mt-2">
      <div className="h-2 overflow-hidden rounded-full bg-[var(--ring-track)]">
        <div
          className={`h-full rounded-full ${over ? "bg-[var(--signal-critical)]" : pct >= 80 ? "bg-[var(--signal-warning)]" : "bg-[var(--accent-progress)]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[var(--type-micro-size)] text-[var(--text-micro)]">
        <span className="tnum">{formatUSD(spent)}</span>
        <span className="tnum">{formatUSD(limit)}</span>
      </div>
    </div>
  );
}

export default function BudgetsPage() {
  const [drill, setDrill] = useState<string | null>(null); // category or "__total__"
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;

  const rows = useMemo(
    () =>
      demoBudgets.map((b) => {
        const txns = categoryDrilldown(demoTransactions, y, m, b.category as "__total__");
        const spent = txns.reduce((s, t) => s + Math.abs(t.amount_cents), 0);
        return { ...b, spent };
      }),
    [y, m]
  );

  const drillTxns = useMemo(
    () => (drill ? categoryDrilldown(demoTransactions, y, m, drill as "__total__") : []),
    [drill, y, m]
  );
  const drillBudget = drill ? demoBudgets.find((b) => b.category === drill) : undefined;
  const drillSpent = drillTxns.reduce((s, t) => s + Math.abs(t.amount_cents), 0);

  if (drill) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setDrill(null)}
          className="text-[var(--type-caption-size)] text-[var(--accent-progress)] font-semibold"
        >
          ← Back to budgets
        </button>
        <div className="rounded-xl bg-[var(--surface-card)] p-5 elev-1">
          <h1 className="text-[var(--type-title-size)] font-bold">
            {drill === "__total__" ? "All September spending" : drill}
          </h1>
          {drillBudget && <PaceBar spent={drillSpent} limit={drillBudget.limit_cents} />}
        </div>
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl bg-[var(--surface-card)] elev-1">
          {drillTxns.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[var(--type-body-size)]">{t.merchant}</p>
                <p className="text-[var(--type-micro-size)] text-[var(--text-micro)]">
                  {t.date} · {t.category}
                </p>
              </div>
              <span className="tnum shrink-0 font-semibold">{formatUSD(t.amount_cents)}</span>
            </li>
          ))}
          {drillTxns.length === 0 && (
            <li className="px-4 py-10 text-center text-[var(--text-secondary)]">
              No charges in this category yet this month.
            </li>
          )}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-[var(--type-title-size)] font-bold">September budgets</h1>
      <ul className="space-y-3">
        {rows.map((b) => (
          <li key={b.category}>
            <button
              onClick={() => setDrill(b.category)}
              className="w-full rounded-xl bg-[var(--surface-card)] p-4 text-left elev-1 transition-transform active:scale-[0.99]"
            >
              <div className="flex items-center justify-between">
                <p className="text-[var(--type-body-size)] font-semibold">
                  {b.category === "__total__" ? "Monthly ceiling" : b.category}
                </p>
                <span aria-hidden className="text-[var(--text-micro)]">›</span>
              </div>
              <PaceBar spent={b.spent} limit={b.limit_cents} />
            </button>
          </li>
        ))}
      </ul>
      <p className="text-center text-[var(--type-micro-size)] text-[var(--text-micro)]">
        Tap a category to see its charges, biggest first.
      </p>
    </div>
  );
}
