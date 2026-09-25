"use client";

/**
 * Signed-in Budgets. Reads the current local month from the budget table and
 * calculates pace from the real ledger. No demo imports anywhere here.
 */
import { useCallback, useEffect, useState } from "react";
import { formatUSD } from "@/lib/fire";
import type { DataEnvelope } from "@/lib/real-data";
import type {
  BudgetMonthData,
  BudgetDrilldownData,
  ActivityRow,
} from "@/lib/real-data-server";

function PaceBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
  const over = spent > limit;
  return (
    <div className="mt-2">
      <div className="h-2 overflow-hidden rounded-full bg-[var(--ring-track)]">
        <div
          className={`h-full rounded-full ${over ? "bg-[var(--signal-critical)]" : pct >= 80 ? "bg-[var(--signal-warning)]" : "bg-[var(--accent-progress)]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
        <span className="tnum">{formatUSD(spent)}</span>
        <span className="tnum">{formatUSD(limit)}</span>
      </div>
    </div>
  );
}

function SetupForm({
  month,
  monthLabel,
  initialCeiling,
  initialLimits,
  observed,
  onSaved,
}: {
  month: string;
  monthLabel: string;
  initialCeiling: string;
  initialLimits: Record<string, string>;
  observed: string[];
  onSaved: () => void;
}) {
  const [ceiling, setCeiling] = useState(initialCeiling);
  const [limits, setLimits] = useState<Record<string, string>>(initialLimits);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!ceiling.trim() || Number.isNaN(Number(ceiling)) || Number(ceiling) < 0) {
      setError("Enter a monthly ceiling in dollars.");
      return;
    }
    setSaving(true);
    try {
      const categories = Object.entries(limits)
        .filter(([, v]) => v.trim() !== "")
        .map(([category, limit]) => ({ category, limit }));
      const res = await fetch("/api/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, ceiling, categories }),
      });
      if (!res.ok) throw new Error("save failed");
      onSaved();
    } catch {
      setError("Couldn't save — please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="rounded-xl bg-[var(--surface-card)] p-6 elev-1 space-y-5">
      <div>
        <h2 className="text-lg font-bold text-[var(--text-primary)]">Set your {monthLabel} budget</h2>
        <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Start with a monthly ceiling. Category limits are optional.
        </p>
      </div>
      <div>
        <label htmlFor="ceiling" className="text-[length:var(--type-caption-size)] font-semibold">
          Monthly ceiling ($)
        </label>
        <input
          id="ceiling"
          inputMode="decimal"
          value={ceiling}
          onChange={(e) => setCeiling(e.target.value)}
          placeholder="e.g. 4000"
          className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-3 py-2"
        />
      </div>
      {observed.length > 0 && (
        <div className="space-y-3">
          <p className="text-[length:var(--type-caption-size)] font-semibold">Category limits (optional)</p>
          {observed.map((cat) => (
            <div key={cat} className="flex items-center justify-between gap-3">
              <label htmlFor={`lim-${cat}`} className="text-[length:var(--type-body-size)]">
                {cat}
              </label>
              <input
                id={`lim-${cat}`}
                inputMode="decimal"
                value={limits[cat] ?? ""}
                onChange={(e) => setLimits((l) => ({ ...l, [cat]: e.target.value }))}
                placeholder="$"
                className="w-32 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-3 py-2 text-right"
              />
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-[var(--signal-critical)]">{error}</p>}
      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-lg bg-[var(--accent-progress)] px-4 py-3 font-semibold text-white disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save budget"}
      </button>
    </form>
  );
}

function Drilldown({ category, onBack }: { category: string; onBack: () => void }) {
  const [data, setData] = useState<BudgetDrilldownData | null>(null);
  useEffect(() => {
    fetch(`/api/budgets?drilldown=${encodeURIComponent(category)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((e) => e && setData(e.data as BudgetDrilldownData))
      .catch(() => {});
  }, [category]);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm font-semibold text-[var(--accent-progress)]">
        ← Back to budgets
      </button>
      <h2 className="text-lg font-bold">{category === "__total__" ? "All spending" : category}</h2>
      {!data ? (
        <p className="text-[var(--text-secondary)]">Loading…</p>
      ) : (
        <>
          {data.limitCents != null && <PaceBar spent={data.spentCents} limit={data.limitCents} />}
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl bg-[var(--surface-card)] elev-1">
            {data.rows.map((t: ActivityRow) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[length:var(--type-body-size)]">{t.merchant}</p>
                  <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">{t.postedAt}</p>
                </div>
                <span className="tnum shrink-0 font-semibold">{formatUSD(t.amountCents)}</span>
              </li>
            ))}
            {data.rows.length === 0 && (
              <li className="px-4 py-10 text-[var(--text-secondary)]">No spending here this month.</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

export default function BudgetsReal() {
  const [env, setEnv] = useState<DataEnvelope<BudgetMonthData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [drill, setDrill] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch("/api/budgets", { cache: "no-store" });
      if (!res.ok) throw new Error("budgets fetch failed");
      setEnv((await res.json()) as DataEnvelope<BudgetMonthData>);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Budgets</h1>
        <p className="text-[var(--text-secondary)]">Loading your budget…</p>
      </div>
    );
  }

  if (failed || !env) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Budgets</h1>
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <p>We couldn't load your budget.</p>
          {env?.support_code && (
            <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              Support code: {env.support_code}
            </p>
          )}
          <button
            onClick={load}
            className="mt-4 rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (env.mode === "unavailable") {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Budgets</h1>
        <p className="text-[var(--text-secondary)]">Budgets are temporarily unavailable. Please check back shortly.</p>
      </div>
    );
  }

  const d = env.data;

  if (drill) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Budgets</h1>
        <Drilldown category={drill} onBack={() => setDrill(null)} />
      </div>
    );
  }

  const observed = [...new Set([...d.categories.map((c) => c.category), ...d.unbudgeted.categories])].sort();
  const showSetup = d.ceilingCents == null || editing;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Budgets</h1>
        <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">{d.monthLabel}</p>
      </div>

      {showSetup ? (
        <SetupForm
          month={d.month}
          monthLabel={d.monthLabel}
          initialCeiling={d.ceilingCents != null ? (d.ceilingCents / 100).toString() : ""}
          initialLimits={Object.fromEntries(d.categories.map((c) => [c.category, (c.limitCents / 100).toString()]))}
          observed={observed}
          onSaved={() => {
            setEditing(false);
            load();
          }}
        />
      ) : (
        <>
          <section aria-label="Monthly pace" className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
            <div className="flex items-baseline justify-between">
              <p className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
                {d.monthLabel} pace
              </p>
              <button
                onClick={() => setEditing(true)}
                className="text-[length:var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
              >
                Edit
              </button>
            </div>
            <PaceBar spent={d.spentCents} limit={d.ceilingCents!} />
            <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              {d.expectedCents != null && (
                <>
                  Expected by day {d.elapsedDays}: {formatUSD(d.expectedCents)} ·{" "}
                </>
              )}
              {d.perDayCents != null && <>Budget left per day: {formatUSD(d.perDayCents)}</>}
            </p>
            <button
              onClick={() => setDrill("__total__")}
              className="mt-3 text-[length:var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
            >
              See all transactions →
            </button>
          </section>

          <section aria-label="Categories" className="space-y-3">
            {d.categories.map((c) => (
              <button
                key={c.category}
                onClick={() => setDrill(c.category)}
                className="block w-full rounded-xl bg-[var(--surface-card)] p-4 text-left elev-1"
              >
                <div className="flex items-baseline justify-between">
                  <p className="font-semibold">{c.category}</p>
                  <p className="tnum text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                    {c.txnCount} transactions
                  </p>
                </div>
                <PaceBar spent={c.spentCents} limit={c.limitCents} />
              </button>
            ))}
            {(d.unbudgeted.spentCents > 0 || d.unbudgeted.txnCount > 0) && (
              <div className="rounded-xl bg-[var(--surface-card)] p-4 elev-1">
                <div className="flex items-baseline justify-between">
                  <p className="font-semibold text-[var(--text-secondary)]">Unbudgeted</p>
                  <p className="tnum text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                    {formatUSD(d.unbudgeted.spentCents)} · {d.unbudgeted.txnCount} transactions
                  </p>
                </div>
                <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                  Real spending in categories without limits{ d.unbudgeted.categories.length > 0 ? `: ${d.unbudgeted.categories.join(", ")}` : ""}.
                </p>
              </div>
            )}
            {d.categories.length === 0 && d.unbudgeted.spentCents === 0 && (
              <p className="text-[var(--text-secondary)]">No spending posted this month yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
