"use client";

/**
 * Signed-in Activity. Server-backed list with a client filter shell.
 * Reads ONLY the user's immutable ledger via /api/activity — no demo
 * imports anywhere in this module.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ConnectBank from "./ConnectBank";
import { formatUSD } from "@/lib/fire";
import type { DataEnvelope } from "@/lib/real-data";
import type { ActivityData, ActivityRow } from "@/lib/real-data-server";

const KIND_LABEL: Record<string, string> = {
  income: "income",
  expense: "spending",
  transfer: "transfer",
  refund: "refund",
  fee: "fee",
};

type Filter = "all" | "spending" | "income" | "transfer" | "pending";
const FILTERS: Filter[] = ["all", "spending", "income", "transfer", "pending"];

function formatDate(iso: string): string {
  // Date-only ledger fact: never shifted across calendar days.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Row({ row }: { row: ActivityRow }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-[length:var(--type-body-size)]">
          {row.merchant}
          {row.pending && (
            <span className="ml-2 rounded-full bg-[var(--signal-warning-soft)] px-2 py-0.5 text-[length:var(--type-micro-size)] text-[var(--signal-warning)]">
              pending
            </span>
          )}
        </p>
        <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
          {formatDate(row.postedAt)} · {row.category} · {KIND_LABEL[row.kind] ?? row.kind}
          {row.accountName ? ` · ${row.accountName}` : ""}
        </p>
      </div>
      <span
        className={`tnum shrink-0 font-semibold ${
          row.amountCents < 0 ? "text-[var(--text-primary)]" : "text-[var(--accent-progress)]"
        }`}
      >
        {formatUSD(row.amountCents)}
      </span>
    </li>
  );
}

export default function ActivityReal() {
  const [env, setEnv] = useState<DataEnvelope<ActivityData> | null>(null);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const runId = useRef(0);

  const fetchPage = useCallback(async (cursor: string | null, f: Filter, q: string, append: boolean) => {
    const id = ++runId.current;
    const params = new URLSearchParams({ filter: f });
    if (cursor) params.set("cursor", cursor);
    if (q) params.set("q", q);
    const res = await fetch(`/api/activity?${params}`, { cache: "no-store" });
    if (id !== runId.current) return; // stale
    if (!res.ok) throw new Error("activity fetch failed");
    const e = (await res.json()) as DataEnvelope<ActivityData>;
    if (id !== runId.current) return;
    setEnv(e);
    setRows((prev) => (append ? [...prev, ...e.data.rows] : e.data.rows));
    setNextCursor(e.data.nextCursor);
    setError(false);
  }, []);

  const reload = useCallback(
    (f: Filter, q: string) => {
      setLoading(true);
      setError(false);
      fetchPage(null, f, q, false).catch(() => setError(true)).finally(() => setLoading(false));
    },
    [fetchPage]
  );

  useEffect(() => {
    reload(filter, query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeFilter(f: Filter) {
    setFilter(f);
    reload(f, query);
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = draft.trim();
    setQuery(q); // search term never enters analytics (server-side only)
    reload(filter, q);
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(nextCursor, filter, query, true);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Activity</h1>
        <p className="text-[var(--text-secondary)]">Loading your activity…</p>
      </div>
    );
  }

  if (error || !env) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Activity</h1>
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <p className="text-[length:var(--type-body-size)] text-[var(--text-primary)]">
            We couldn't load your activity.
          </p>
          {env?.support_code && (
            <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              Support code: {env.support_code}
            </p>
          )}
          <button
            onClick={() => reload(filter, query)}
            className="mt-4 rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (env.mode === "setup") {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Activity</h1>
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1 space-y-3">
          <p className="text-[length:var(--type-body-size)]">Connect a bank to see activity.</p>
          <ConnectBank />
        </div>
      </div>
    );
  }

  if (env.mode === "syncing") {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Activity</h1>
        <p className="text-[var(--text-secondary)]">Your first transactions are syncing.</p>
      </div>
    );
  }

  if (env.mode === "unavailable") {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Activity</h1>
        <p className="text-[var(--text-secondary)]">Activity is temporarily unavailable. Please check back shortly.</p>
      </div>
    );
  }

  const emptyAll = rows.length === 0 && !query && filter === "all";

  return (
    <div className="space-y-4">
      <h1 className="text-[length:var(--type-title-size)] font-bold">Activity</h1>

      <form onSubmit={submitSearch} className="flex gap-2">
        <label className="sr-only" htmlFor="txn-search">Search transactions</label>
        <input
          id="txn-search"
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search merchants or categories"
          className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-[length:var(--type-body-size)]"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
        >
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by type">
        {FILTERS.map((k) => (
          <button
            key={k}
            onClick={() => changeFilter(k)}
            aria-pressed={filter === k}
            className={`rounded-full px-3 py-1.5 text-[length:var(--type-caption-size)] capitalize transition-colors ${
              filter === k
                ? "bg-[var(--accent-progress)] text-white"
                : "bg-[var(--surface-secondary)] text-[var(--text-secondary)]"
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      {emptyAll ? (
        <p className="rounded-xl bg-[var(--surface-card)] px-4 py-10 text-[var(--text-secondary)] elev-1">
          No transactions received yet.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl bg-[var(--surface-card)] elev-1">
            {rows.map((t) => (
              <Row key={t.id} row={t} />
            ))}
            {rows.length === 0 && (
              <li className="px-4 py-10 text-[var(--text-secondary)]">
                Nothing matches these filters.
              </li>
            )}
          </ul>
          {nextCursor && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full rounded-xl bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-primary)] disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
          {env.truncated && (
            <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
              Showing recent activity — use search or filters to narrow down.
            </p>
          )}
        </>
      )}
      <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
        Transfers and card payments never count as spending.
      </p>
    </div>
  );
}
