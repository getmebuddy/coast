"use client";

/**
 * Transactions — clean ledger. Merchant, amount, date, category.
 * Pending vs posted distinguished. Transfers/income never count as spending.
 */
import { useMemo, useState } from "react";
import { demoTransactions } from "@/lib/demo";
import { formatUSD } from "@/lib/fire";

const KIND_LABEL: Record<string, string> = {
  income: "income",
  expense: "spending",
  transfer: "transfer",
  refund: "refund",
  fee: "fee",
};

export default function TransactionsPage() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "spending" | "income" | "transfer">("all");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return demoTransactions.filter((t) => {
      if (kind === "spending" && t.kind !== "expense" && t.kind !== "fee") return false;
      if (kind === "income" && t.kind !== "income" && t.kind !== "refund") return false;
      if (kind === "transfer" && t.kind !== "transfer") return false;
      if (q && !`${t.merchant} ${t.category}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [query, kind]);

  return (
    <div className="space-y-4">
      <h1 className="text-[length:var(--type-title-size)] font-bold">Activity</h1>

      <div className="flex gap-2">
        <label className="sr-only" htmlFor="txn-search">Search transactions</label>
        <input
          id="txn-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search merchants or categories"
          className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-[length:var(--type-body-size)]"
        />
      </div>

      <div className="flex gap-2" role="group" aria-label="Filter by type">
        {(["all", "spending", "income", "transfer"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={`rounded-full px-3 py-1.5 text-[length:var(--type-caption-size)] capitalize transition-colors ${
              kind === k
                ? "bg-[var(--accent-progress)] text-white"
                : "bg-[var(--surface-secondary)] text-[var(--text-secondary)]"
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      <ul className="divide-y divide-[var(--border-subtle)] rounded-xl bg-[var(--surface-card)] elev-1">
        {rows.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-[length:var(--type-body-size)]">
                {t.merchant}
                {t.pending && (
                  <span className="ml-2 rounded-full bg-[var(--signal-warning-soft)] px-2 py-0.5 text-[length:var(--type-micro-size)] text-[var(--signal-warning)]">
                    pending
                  </span>
                )}
              </p>
              <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
                {t.date} · {t.category} · {KIND_LABEL[t.kind]}
              </p>
            </div>
            <span
              className={`tnum shrink-0 font-semibold ${
                t.amount_cents < 0 ? "text-[var(--text-primary)]" : "text-[var(--accent-progress)]"
              }`}
            >
              {formatUSD(t.amount_cents)}
            </span>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="px-4 py-10 text-[var(--text-secondary)]">
            Nothing matches — try a different search.
          </li>
        )}
      </ul>
      <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
        Transfers and card payments never count as spending.
      </p>
    </div>
  );
}
