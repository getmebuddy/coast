"use client";

/**
 * RefreshAccountsButton — manual Plaid re-sync.
 * POSTs /api/plaid/sync (the same endpoint the initial connect flow uses),
 * then calls onSynced so the host page reloads its data.
 * Render only for signed-in users with a connected bank.
 */
import { useState } from "react";

export default function RefreshAccountsButton({
  onSynced,
}: {
  onSynced?: () => void | Promise<void>;
}) {
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);

  async function refresh() {
    if (syncing) return;
    setSyncing(true);
    setFailed(false);
    try {
      const res = await fetch("/api/plaid/sync", { method: "POST" });
      if (!res.ok) throw new Error("sync failed");
      await onSynced?.();
    } catch {
      setFailed(true);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button
      type="button"
      onClick={refresh}
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
