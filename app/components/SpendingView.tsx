"use client";

/**
 * Spending explorer — presentational view shared by the signed-in page
 * (real data via /api/spending) and the signed-out demo.
 *
 * Week / Month / Quarter / Year toggle, income-vs-spend bars per period,
 * a finish-line pace marker from the user's FIRE settings ("spending vs.
 * your finish line"), net income for the selected period, and tap-to-drill
 * category rows with their biggest transactions.
 */
import { useState } from "react";
import { formatUSD } from "@/lib/fire";
import MerchantIcon from "./MerchantIcon";
import { SPENDING_RANGES, type SpendingData, type SpendingRange } from "@/lib/spending";

const RANGE_LABELS: Record<SpendingRange, string> = {
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};

function Chart({ range, data }: { range: SpendingRange; data: SpendingData }) {
  const period = data.ranges[range];
  const buckets = period.buckets;
  const maxVal = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.incomeCents, b.spendCents)),
    period.finishLinePerBucketCents ?? 0
  );
  const linePct =
    period.finishLinePerBucketCents != null
      ? Math.min(100, (period.finishLinePerBucketCents / maxVal) * 100)
      : null;

  return (
    <div>
      <div className="relative" aria-hidden>
        {linePct != null && (
          <div className="pointer-events-none absolute inset-x-0" style={{ bottom: `${linePct}%` }}>
            <div className="border-t border-dashed border-[var(--accent-progress)]" />
            <span className="absolute right-0 -top-4 rounded bg-[var(--accent-progress-soft)] px-1.5 py-0.5 text-[length:var(--type-micro-size)] font-semibold text-[var(--accent-progress)]">
              finish-line pace
            </span>
          </div>
        )}
        <div className="flex h-44 items-end gap-2 pt-6">
          {buckets.map((b) => {
            const spendH = Math.max(2, (b.spendCents / maxVal) * 100);
            const incomeH = Math.max(2, (b.incomeCents / maxVal) * 100);
            return (
              <div key={b.key} className="flex flex-1 flex-col items-center gap-1" title={`${b.label}: ${formatUSD(b.incomeCents)} in, ${formatUSD(b.spendCents)} out`}>
                <div className="flex h-full w-full items-end justify-center gap-0.5">
                  <div
                    className="w-2.5 rounded-t bg-[var(--accent-progress)]"
                    style={{ height: `${incomeH}%` }}
                  />
                  <div
                    className="w-2.5 rounded-t bg-[var(--signal-warning)]"
                    style={{ height: `${spendH}%` }}
                  />
                </div>
                <span className="truncate text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
                  {b.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-4 text-[length:var(--type-micro-size)] text-[var(--text-secondary)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent-progress)]" /> Income
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--signal-warning)]" /> Spending
        </span>
      </div>
    </div>
  );
}

export default function SpendingView({ data, demo = false }: { data: SpendingData; demo?: boolean }) {
  const [range, setRange] = useState<SpendingRange>("month");
  const [openCat, setOpenCat] = useState<string | null>(null);
  const period = data.ranges[range];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[length:var(--type-title-size)] font-bold">Spending</h1>
        <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          {demo
            ? "Demo data. Sign in to see your own spending."
            : "How money moved, against the pace your finish line needs."}
        </p>
      </div>

      <div role="group" aria-label="Time range" className="flex gap-1 rounded-full bg-[var(--surface-secondary)] p-1">
        {SPENDING_RANGES.map((r) => (
          <button
            key={r}
            aria-pressed={range === r}
            onClick={() => {
              setRange(r);
              setOpenCat(null);
            }}
            className={`flex-1 rounded-full px-3 py-2 text-sm font-semibold transition-colors ${
              range === r ? "bg-[var(--surface-card)] text-[var(--text-primary)] elev-1" : "text-[var(--text-secondary)]"
            }`}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>

      <section aria-label="Income versus spending" className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
        <p className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          {period.periodLabel}
        </p>
        <p className="mt-2 text-[length:var(--type-title-size)] font-bold tnum">
          {formatUSD(period.netIncomeCents)}
          <span className="ml-2 text-[length:var(--type-caption-size)] font-normal text-[var(--text-secondary)]">
            net income
          </span>
        </p>
        <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)] tnum">
          {formatUSD(period.totalIncomeCents)} in · {formatUSD(period.totalSpendCents)} out
        </p>
        <div className="mt-4">
          <Chart range={range} data={data} />
        </div>
        {data.finishLineMonthlyCents != null && (
          <p className="mt-3 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            Dashed line: your finish-line pace — {formatUSD(data.finishLineMonthlyCents)} a month keeps
            your spending at the level your Number was built on.
          </p>
        )}
        {data.finishLineMonthlyCents == null && (
          <p className="mt-3 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            Set your Number to see the finish-line pace your spending is measured against.{" "}
            <a href="/number" className="font-semibold text-[var(--accent-progress)]">
              Set your Number →
            </a>
          </p>
        )}
      </section>

      <section aria-label="Spending by category" className="space-y-3">
        <h2 className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          By category
        </h2>
        {period.categories.map((c) => {
          const open = openCat === c.category;
          const pct = period.totalSpendCents > 0 ? (c.spendCents / period.totalSpendCents) * 100 : 0;
          return (
            <div key={c.category} className="rounded-xl bg-[var(--surface-card)] elev-1">
              <button
                onClick={() => setOpenCat(open ? null : c.category)}
                aria-expanded={open}
                className="block w-full p-4 text-left"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-semibold">{c.category}</p>
                  <p className="tnum text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                    {formatUSD(c.spendCents)} · {c.txnCount} transactions
                  </p>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--ring-track)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent-progress)]"
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </button>
              {open && (
                <ul className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] px-4">
                  {c.top.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-3">
                        <MerchantIcon logoUrl={t.logoUrl} merchantName={t.merchant} size={32} />
                        <div className="min-w-0">
                          <p className="truncate text-[length:var(--type-body-size)]">{t.merchant}</p>
                          <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">{t.date}</p>
                        </div>
                      </div>
                      <span className="tnum shrink-0 font-semibold">{formatUSD(t.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {period.categories.length === 0 && (
          <p className="text-[var(--text-secondary)]">No spending posted in this period yet.</p>
        )}
      </section>
    </div>
  );
}
