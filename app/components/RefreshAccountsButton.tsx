"use client";

/**
 * RefreshAccountsButton — manual Plaid re-sync, plus opt-in auto-sync.
 * POSTs /api/plaid/sync (the same endpoint the initial connect flow uses),
 * then calls onSynced so the host page reloads its data.
 * Render only for signed-in users with a connected bank.
 *
 * autoSync: when enabled and the last sync is stale (see lib/sync.ts),
 * runs one background sync on mount. Failures stay silent — the page
 * simply keeps showing the last synced data.
 */
import { useEffect, useRef, useState } from "react";
import { shouldSync } from "@/lib/sync";

export default function RefreshAccountsButton({
  onSynced,
  autoSync,
}: {
  onSynced?: () => void | Promise<void>;
  autoSync?: { lastSyncAt: string | null | undefined; enabled: boolean };
}) {
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);
  const autoRan = useRef(false);

  async function runSync() {
    const res = await fetch("/api/plaid/sync", { method: "POST" });
    if (!res.ok) throw new Error("sync failed");
    await onSynced?.();
  }

  async function manualRefresh() {
    if (syncing) return;
    setSyncing(true);
    setFailed(false);
    try {
      await runSync();
    } catch {
      setFailed(true);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (!autoSync?.enabled || autoRan.current) return;
    if (!shouldSync(autoSync.lastSyncAt)) return;
    autoRan.current = true;
    (async () => {
      setSyncing(true);
      try {
        await runSync();
      } catch {
        // Silent: stale data is acceptable, the page already rendered.
      } finally {
        setSyncing(false);
      }
    })();
    // Intentionally mount-only: the ref guards re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <button
      type="button"
      onClick={manualRefresh}
      disabled={syncing}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-[length:var(--type-caption-size)] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-60"
      aria-live="polite"
    >
      <span
        aria-hidden
        className={`inline-block ${syncing ? "animate-spin" : ""}`}
      >
        ↻
      </span>
      {syncing ? "Syncing…" : failed ? "Couldn't refresh — tap to retry" : "Refresh"}
    </button>
  );
}
