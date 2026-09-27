/**
 * Sync freshness helpers.
 * Plaid production charges per sync call, so the app auto-syncs only when
 * the ledger is stale — not on every open.
 */

/** Auto-sync when the last successful sync is older than this. */
export const SYNC_STALE_MS = 6 * 3600 * 1000;

/**
 * True when a Plaid re-sync should run: never synced, unparseable
 * timestamp, or older than SYNC_STALE_MS.
 */
export function shouldSync(
  lastSyncAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (lastSyncAt == null) return true;
  const t = new Date(lastSyncAt).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t > SYNC_STALE_MS;
}
