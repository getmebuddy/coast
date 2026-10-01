"use client";

/**
 * Spending explorer — presentational view shared by the signed-in page
 * (real data via /api/spending) and the signed-out demo.
 *
 * Week / Month / Quarter / Year toggle, income-vs-spend bars per period
 * (tap a bar to drill into that period), a finish-line pace marker from the
 * user's FIRE settings, net income with an earned-vs-spent comparison line,
 * icon-led Income / Total Spend rows, a donut of the category breakdown,
 * and tap-to-drill category rows with their biggest transactions.
 */
import { useEffect, useState } from "react";
import { formatUSD } from "@/lib/fire";
import MerchantIcon from "./MerchantIcon";
import {
  SPENDING_RANGES,
  buildDonutData,
  netIncomeLine,
  type DonutSegment,
  type SpendingBucket,
  type SpendingCategoryRow,
  type SpendingData,
  type SpendingRange,
} from "@/lib/spending";

const RANGE_LABELS: Record<SpendingRange, string> = {
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};

function MoneyBagIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-[var(--accent-progress)]"
      aria-hidden="true"
    >
      <path d="M9.2 3.8h5.6" />
      <path d="M10 3.8c.2 1.6-.6 3-2.4 4.4" />
      <path d="M14 3.8c-.2 1.6.6 3 2.4 4.4" />
      <path d="M7.6 8.2h8.8l1.7 6.1c.4 1.5-.3 2.7-1.4 3.6-1.4 1.1-3.2 1.6-4.7 1.6s-3.3-.5-4.7-1.6c-1.1-.9-1.8-2.1-1.4-3.6l1.7-6.1z" />
      <path d="M12 11.6v4" />
      <path d="M13.4 12.4c-.3-.4-.8-.6-1.4-.6-.8 0-1.4.4-1.4 1 0 1.4 2.9.7 2.9 2.1 0 .6-.6 1-1.5 1-.5 0-1-.2-1.3-.6" />
    </svg>
  );
}

function CashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-[var(--signal-warning)]"
      aria-hidden="true"
    >
      <rect x="2.5" y="7" width="19" height="10" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 10.4v.01" />
      <path d="M18 13.6v.01" />
    </svg>
  );
}

/**
 * Annular-sector clip path for a donut segment overlay button.
 * Angles in radians, 0 = 12 o'clock, clockwise — matching the SVG below.
 */
function sectorClip(a0: number, a1: number): string {
  const pts: string[] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const a = a0 + ((a1 - a0) * i) / N;
    pts.push(`${(50 + 48 * Math.sin(a)).toFixed(2)}% ${(50 - 48 * Math.cos(a)).toFixed(2)}%`);
  }
  for (let i = N; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / N;
    pts.push(`${(50 + 28 * Math.sin(a)).toFixed(2)}% ${(50 - 28 * Math.cos(a)).toFixed(2)}%`);
  }
  return `polygon(${pts.join(",")})`;
}

/**
 * Donut of the category breakdown. The ring itself is aria-hidden; each
 * segment is a real <button> clipped to its annular sector, so tapping a
 * segment is the same action as tapping the matching list row.
 */
function Donut({
  segments,
  totalCents,
  onSelect,
}: {
  segments: DonutSegment[];
  totalCents: number;
  onSelect: (category: string | null) => void;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const R = 64;

  if (segments.length === 0) {
    return (
      <div className="relative mx-auto h-52 w-52" role="img" aria-label="No spending in this period">
        <svg viewBox="0 0 160 160" className="h-full w-full" aria-hidden="true">
          <circle cx="80" cy="80" r={R} fill="none" stroke="var(--ring-track)" strokeWidth="26" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
            Total spend
          </span>
          <span className="tnum text-[length:var(--type-title-size)] font-bold">{formatUSD(0)}</span>
        </div>
      </div>
    );
  }

  let acc = 0;
  const arcs = segments.map((s) => {
    const start = acc;
    acc += s.pct;
    return { ...s, start };
  });

  return (
    <div className="relative mx-auto h-52 w-52">
      <svg viewBox="0 0 160 160" className="h-full w-full" aria-hidden="true">
        <g transform="rotate(-90 80 80)">
          <circle cx="80" cy="80" r={R} fill="none" stroke="var(--ring-track)" strokeWidth="26" />
          {arcs.map((a, i) => {
            const len = Math.max(a.pct - 0.7, 0.15);
            return (
              <circle
                key={a.category}
                cx="80"
                cy="80"
                r={R}
                fill="none"
                pathLength={100}
                style={{
                  stroke: a.colorIndex === 0 ? "var(--text-micro)" : `var(--chart-${a.colorIndex})`,
                  transition: "stroke-width 120ms ease-out",
                }}
                strokeWidth={activeIdx === i ? 31 : 26}
                strokeDasharray={`${len} ${100 - len}`}
                strokeDashoffset={-a.start}
              />
            );
          })}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          Total spend
        </span>
        <span className="tnum text-[length:var(--type-title-size)] font-bold">
          {formatUSD(totalCents)}
        </span>
      </div>
      {arcs.map((a, i) => {
        const a0 = (a.start / 100) * Math.PI * 2;
        const a1 = ((a.start + a.pct) / 100) * Math.PI * 2;
        const isOther = a.category === "Other";
        const label = isOther
          ? `Other categories: ${formatUSD(a.spendCents)}, ${a.pct.toFixed(0)} percent of spending`
          : `${a.category}: ${formatUSD(a.spendCents)}, ${a.pct.toFixed(0)} percent of spending. Activate to show its transactions.`;
        return (
          <button
            key={a.category}
            type="button"
            aria-label={label}
            className="absolute inset-0 cursor-pointer"
            style={{ clipPath: sectorClip(a0, a1) }}
            onClick={() => onSelect(isOther ? null : a.category)}
            onFocus={() => setActiveIdx(i)}
            onBlur={() => setActiveIdx(null)}
            onMouseEnter={() => setActiveIdx(i)}
            onMouseLeave={() => setActiveIdx(null)}
          >
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Chart({
  range,
  data,
  selectedKey,
  onSelectBucket,
}: {
  range: SpendingRange;
  data: SpendingData;
  selectedKey: string | null;
  onSelectBucket: (key: string | null) => void;
}) {
  const period = data.ranges[range];
  const buckets = period.buckets;
  const latestKey = buckets[buckets.length - 1].key;
  const activeKey = selectedKey ?? latestKey;
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
      <div className="relative">
        <div className="flex h-44 items-end gap-2 pt-6" role="group" aria-label="Periods — activate a bar to drill into it">
          {buckets.map((b) => {
            const selected = b.key === activeKey;
            const spendH = Math.max(2, (b.spendCents / maxVal) * 100);
            const incomeH = Math.max(2, (b.incomeCents / maxVal) * 100);
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => onSelectBucket(selected ? null : b.key)}
                aria-pressed={selected}
                aria-label={`${b.label}: ${formatUSD(b.incomeCents)} in, ${formatUSD(b.spendCents)} out${selected ? ", selected" : ""}`}
                title={`${b.label}: ${formatUSD(b.incomeCents)} in, ${formatUSD(b.spendCents)} out`}
                className="flex flex-1 cursor-pointer flex-col items-center gap-1 rounded"
              >
                <div className="flex h-full w-full items-end justify-center gap-0.5">
                  <div
                    className="w-2.5 rounded-t bg-[var(--accent-progress)]"
                    style={{ height: `${incomeH}%`, opacity: selected ? 1 : 0.55 }}
                  />
                  <div
                    className="w-2.5 rounded-t bg-[var(--signal-warning)]"
                    style={{ height: `${spendH}%`, opacity: selected ? 1 : 0.55 }}
                  />
                </div>
                <span
                  className={`truncate text-[length:var(--type-micro-size)] ${
                    selected
                      ? "font-bold text-[var(--text-primary)]"
                      : "text-[var(--text-micro)]"
                  }`}
                >
                  {b.label}
                </span>
              </button>
            );
          })}
        </div>
        {linePct != null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-6 bottom-6"
          >
            <div
              className="absolute inset-x-0 border-t border-dashed border-[var(--accent-progress)]"
              style={{ top: `${100 - linePct}%` }}
            />
            <span className="absolute right-0 rounded bg-[var(--accent-progress-soft)] px-1.5 py-0.5 text-[length:var(--type-micro-size)] font-semibold text-[var(--accent-progress)]" style={{ top: `calc(${100 - linePct}% - 18px)` }}>
              finish-line pace
            </span>
          </div>
        )}
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

/** Totals-only rows for a bucket whose top transactions haven't loaded yet. */
function totalsAsRows(bucket: SpendingBucket): SpendingCategoryRow[] {
  return bucket.categoryTotals.map((t) => ({
    category: t.category,
    spendCents: t.spendCents,
    txnCount: t.txnCount,
    top: [],
  }));
}

export default function SpendingView({ data, demo = false }: { data: SpendingData; demo?: boolean }) {
  const [range, setRange] = useState<SpendingRange>("month");
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [bucketKey, setBucketKey] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SpendingCategoryRow[]>>({});
  const [loadingBucket, setLoadingBucket] = useState(false);

  const period = data.ranges[range];
  const latestBucket = period.buckets[period.buckets.length - 1];
  const activeBucket: SpendingBucket =
    bucketKey != null
      ? (period.buckets.find((b) => b.key === bucketKey) ?? latestBucket)
      : latestBucket;
  const drilled = activeBucket.key !== latestBucket.key;

  // Switching ranges resets the drill-down.
  useEffect(() => {
    setBucketKey(null);
    setOpenCat(null);
  }, [range]);

  // Lazy-load top transactions for a drilled-into bucket (signed-in only).
  useEffect(() => {
    if (demo || !drilled || details[activeBucket.key]) return;
    let cancelled = false;
    setLoadingBucket(true);
    fetch(`/api/spending?bucket=${encodeURIComponent(activeBucket.key)}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("bucket detail failed");
        return r.json();
      })
      .then((env) => {
        if (!cancelled) {
          setDetails((d) => ({
            ...d,
            [activeBucket.key]: env.data.categories as SpendingCategoryRow[],
          }));
        }
      })
      .catch(() => {
        /* totals-only fallback stays in place */
      })
      .finally(() => {
        if (!cancelled) setLoadingBucket(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demo, drilled, activeBucket.key, details]);

  const income = activeBucket.incomeCents;
  const spend = activeBucket.spendCents;
  const net = income - spend;
  const comparison = netIncomeLine(income, spend);
  const displayCategories: SpendingCategoryRow[] = drilled
    ? (details[activeBucket.key] ?? totalsAsRows(activeBucket))
    : period.categories;
  const donut = buildDonutData(displayCategories, spend);

  const periodLabel = drilled
    ? range === "week"
      ? `Week of ${activeBucket.label}`
      : activeBucket.label
    : period.periodLabel;

  const selectDonutCategory = (category: string | null) => {
    setOpenCat(category);
    if (category) {
      const idx = displayCategories.findIndex((c) => c.category === category);
      if (idx >= 0) {
        document
          .getElementById(`spend-cat-${idx}`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  };

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
        <div className="flex items-center justify-between gap-3">
          <p className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
            {periodLabel}
          </p>
          {drilled && (
            <button
              type="button"
              onClick={() => {
                setBucketKey(null);
                setOpenCat(null);
              }}
              className="shrink-0 rounded-full bg-[var(--surface-secondary)] px-3 py-1 text-[length:var(--type-micro-size)] font-semibold text-[var(--text-secondary)]"
            >
              ← Back to {latestBucket.label}
            </button>
          )}
        </div>
        <p className="mt-2 text-[length:var(--type-title-size)] font-bold tnum">
          {formatUSD(net)}
          <span className="ml-2 text-[length:var(--type-caption-size)] font-normal text-[var(--text-secondary)]">
            net income
          </span>
        </p>
        {comparison && (
          <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            {comparison}
          </p>
        )}
        <div className="mt-4 space-y-2.5 border-t border-[var(--border-subtle)] pt-4">
          <div className="flex items-center gap-3">
            <MoneyBagIcon />
            <p className="text-[length:var(--type-body-size)]">Income</p>
            <p className="tnum ml-auto font-semibold">{formatUSD(income)}</p>
          </div>
          <div className="flex items-center gap-3">
            <CashIcon />
            <p className="text-[length:var(--type-body-size)]">Total spend</p>
            <p className="tnum ml-auto font-semibold">{formatUSD(spend)}</p>
          </div>
        </div>
        <div className="mt-4">
          <Chart range={range} data={data} selectedKey={bucketKey} onSelectBucket={setBucketKey} />
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
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <Donut segments={donut} totalCents={spend} onSelect={selectDonutCategory} />
          {drilled && loadingBucket && (
            <p className="mt-3 text-center text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              Loading {activeBucket.label}…
            </p>
          )}
        </div>
        {displayCategories.map((c, i) => {
          const open = openCat === c.category;
          const pct = spend > 0 ? (c.spendCents / spend) * 100 : 0;
          return (
            <div key={c.category} id={`spend-cat-${i}`} className="rounded-xl bg-[var(--surface-card)] elev-1">
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
                  {c.top.length === 0 && (
                    <li className="py-2.5 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                      Transactions are loading…
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
        {displayCategories.length === 0 && (
          <p className="text-[var(--text-secondary)]">No spending posted in this period yet.</p>
        )}
      </section>
    </div>
  );
}
