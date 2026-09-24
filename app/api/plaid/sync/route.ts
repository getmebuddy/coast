import { NextResponse } from "next/server";
import { RemovedTransaction, Transaction } from "plaid";
import { decryptAccessToken, getPlaidClient, isPlaidConfigured, toAccountUpsertRow } from "@/lib/plaid";
import { detectRecurring, toRecurringUpsertRows } from "@/lib/recurring";
import { classifyTransaction, normalizeMerchant } from "@/lib/ledger";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";

/**
 * POST /api/plaid/sync — cursor-based incremental transaction sync.
 *
 * Contract (the heart of Coast):
 *  1. Read the stored cursor for each active plaid_item.
 *  2. Page /transactions/sync until has_more is false.
 *  3. Enrich accounts via /accounts/get — genuine names, types, balances.
 *  4. Upsert by (user_id, source='plaid', source_id=plaid transaction_id) —
 *     re-running the sync NEVER duplicates data (idempotent).
 *  5. Mark removed transactions (Plaid `removed`) — ledger rows are immutable,
 *     so removals become a companion tombstone note, not a delete.
 *  6. Advance the cursor ONLY after a successful commit.
 *  7. Refresh recurring charges from the ledger (best-effort).
 *
 * Decryption mirrors the exchange route (AES-256-GCM, key from PLAID_SECRET).
 * Stored values are `\x`-hex strings (PostgREST bytea serialization).
 */
function decryptToken(stored: string): string {
  return decryptAccessToken(stored);
}

type UpsertRow = {
  user_id: string;
  account_id: string | null;
  source: "plaid";
  source_id: string;
  amount_cents: number;
  posted_at: string;
  merchant_raw: string;
  merchant_normalized: string;
  kind: string;
  pending: boolean;
};

async function syncOneItem(
  supabase: ReturnType<typeof createServiceSupabase>,
  userId: string,
  item: { id: string; access_token_encrypted: string; cursor: string | null }
) {
  const client = getPlaidClient();
  const accessToken = decryptToken(item.access_token_encrypted);

  let cursor = item.cursor ?? undefined;
  let added: Transaction[] = [];
  let modified: Transaction[] = [];
  let removed: RemovedTransaction[] = [];
  let hasMore = true;

  while (hasMore) {
    const resp = await client.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 500,
    });
    const d = resp.data;
    added = added.concat(d.added);
    modified = modified.concat(d.modified);
    removed = removed.concat(d.removed);
    cursor = d.next_cursor;
    hasMore = d.has_more;
  }

  // Enrich accounts with real metadata: one /accounts/get per item per sync.
  // Idempotent upsert on (user_id, plaid_account_id) — re-runs update rows
  // in place, never duplicate. Genuine name, official name, type/subtype,
  // mask, and current/available balances (integer cents, Plaid convention).
  const plaidAccountIds = [...new Set(added.concat(modified).map((t) => t.account_id))];
  const accountMap = new Map<string, string>();
  if (plaidAccountIds.length > 0) {
    const accountsResp = await client.accountsGet({ access_token: accessToken });
    const metaById = new Map(accountsResp.data.accounts.map((a) => [a.account_id, a]));
    const nowISO = new Date().toISOString();
    const rows = plaidAccountIds.map((pid) =>
      toAccountUpsertRow(userId, item.id, pid, metaById.get(pid), nowISO)
    );
    const { data, error } = await supabase
      .from("accounts")
      .upsert(rows, { onConflict: "user_id,plaid_account_id" })
      .select("id, plaid_account_id");
    if (error) throw error;
    for (const row of data ?? []) accountMap.set(row.plaid_account_id, row.id);

    // One-time reconciliation: rows written by the pre-enrichment sync
    // (name carried the Plaid account id, plaid_account_id NULL) are
    // superseded by the enriched rows above — remove them so re-runs
    // across the upgrade never leave duplicate accounts behind.
    // (Their transactions' account_id falls back to NULL via ON DELETE SET
    // NULL; this sync's upsert re-links every touched transaction.)
    const { error: cleanupError } = await supabase
      .from("accounts")
      .delete()
      .eq("user_id", userId)
      .eq("plaid_item_id", item.id)
      .is("plaid_account_id", null)
      .in("name", plaidAccountIds);
    if (cleanupError) throw cleanupError;
  }

  const toRow = (t: Transaction): UpsertRow => {
    const raw = t.merchant_name ?? t.name ?? "Unknown";
    const normalized = normalizeMerchant(raw);
    const { amountCents, kind } = classifyTransaction({
      plaidAmount: t.amount, // Plaid: positive = outflow
      merchantNormalized: normalized,
      personalFinanceCategoryPrimary: t.personal_finance_category?.primary ?? null,
    });
    return {
      user_id: userId,
      account_id: accountMap.get(t.account_id) ?? null,
      source: "plaid",
      source_id: t.transaction_id, // stable dedupe key
      amount_cents: amountCents,
      posted_at: t.date,
      merchant_raw: raw,
      merchant_normalized: normalized,
      kind,
      pending: t.pending,
    };
  };

  // IDEMPOTENT upsert: conflicts on (user_id, source, source_id) update nothing
  // new (immutable ledger — pending flag transitions are the one exception,
  // since pending->posted is a state change, not history).
  const rows = added.concat(modified).map(toRow);
  let inserted = 0;
  if (rows.length > 0) {
    const { data, error } = await supabase
      .from("transactions")
      .upsert(rows, { onConflict: "user_id,source,source_id", ignoreDuplicates: false })
      .select("id");
    if (error) throw error;
    inserted = data?.length ?? 0;
  }

  // Removals: ledger is immutable, so flag them via a companion override note.
  for (const r of removed) {
    await supabase.from("transaction_overrides").upsert(
      {
        user_id: userId,
        transaction_id: (
          await supabase
            .from("transactions")
            .select("id")
            .eq("user_id", userId)
            .eq("source", "plaid")
            .eq("source_id", r.transaction_id)
            .maybeSingle()
        ).data?.id,
        category: "REMOVED_BY_BANK",
        note: "Removed by the bank in a later sync.",
      },
      { onConflict: "user_id,transaction_id", ignoreDuplicates: true }
    );
  }

  // Advance the cursor ONLY after a successful commit.
  const { error: cursorError } = await supabase
    .from("plaid_items")
    .update({ cursor, last_sync_at: new Date().toISOString() })
    .eq("id", item.id)
    .eq("user_id", userId);
  if (cursorError) throw cursorError;

  return { item_id: item.id, added: added.length, modified: modified.length, removed: removed.length, upserted: inserted };
}

/**
 * Re-run the recurring-charge detector over the user's ledger and persist
 * the result. Reads ~13 months of posted outflows, detects, and upserts
 * into `recurring` on (user_id, merchant_normalized) — idempotent.
 * A user's explicit dismissal ("not a subscription") is preserved.
 *
 * Subscription Action Center preservation: the detector owns only the
 * detector columns (amounts, cadence, dates, price flags). User/system-curated
 * columns — merchant_key, billing_channel, lifecycle_state, user_correction,
 * amount_model, confidence — are snapshotted before the upsert and re-applied
 * so a refresh never clobbers them (spec FR-02/FR-03). next_expected_at is
 * detector-owned only for active rows.
 *
 * Possible renewal (spec FR-15/FR-26): a series that was 'ended' with no user
 * correction reopens as 'reopened' when the detector reports a newer charge
 * (its next_charge_date advanced past the stored one; last_charge_date is not
 * a stored column, so the advanced next date is the "newer charge" signal).
 * Reopening appends nothing — no request, no event.
 */
async function refreshRecurring(
  supabase: ReturnType<typeof createServiceSupabase>,
  userId: string
): Promise<{ detected: number }> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 400);
  const sinceISO = since.toISOString().slice(0, 10);

  const { data: txns, error } = await supabase
    .from("transactions")
    .select("merchant_normalized, amount_cents, posted_at, kind, pending")
    .eq("user_id", userId)
    .gte("posted_at", sinceISO)
    .in("kind", ["expense", "fee"])
    .eq("pending", false)
    .lt("amount_cents", 0)
    .limit(5000);
  if (error) throw error;

  const detected = detectRecurring(
    (txns ?? []).map((t) => ({
      merchant: t.merchant_normalized,
      amount_cents: t.amount_cents,
      date: t.posted_at,
      kind: t.kind,
      pending: t.pending,
    }))
  );

  const { data: existing, error: existingError } = await supabase
    .from("recurring")
    .select(
      "merchant_normalized, dismissed, merchant_key, billing_channel, " +
        "lifecycle_state, user_correction, amount_model, confidence, " +
        "next_expected_at, next_charge_date"
    )
    .eq("user_id", userId);
  if (existingError) throw existingError;
  const existingRows = (existing ?? []) as Array<{
    merchant_normalized: string;
    dismissed: boolean;
    merchant_key: string | null;
    billing_channel: string | null;
    lifecycle_state: string | null;
    user_correction: string | null;
    amount_model: unknown;
    confidence: number | null;
    next_expected_at: string | null;
    next_charge_date: string | null;
  }>;
  const existingByMerchant = new Map(
    existingRows.map((r) => [r.merchant_normalized, r] as const)
  );
  const dismissedByMerchant = new Map(
    existingRows.map((r) => [r.merchant_normalized, r.dismissed] as const)
  );
  const detectedByMerchant = new Map(detected.map((d) => [d.merchant, d]));

  const nowISO = new Date().toISOString();
  const rows = toRecurringUpsertRows(userId, detected, dismissedByMerchant, nowISO).map(
    (row) => {
      const prev = existingByMerchant.get(row.merchant_normalized);
      if (!prev) return row;

      // Possible renewal (FR-15/FR-26): an ended series with no user
      // correction sees a newer charge → reopen for review.
      const det = detectedByMerchant.get(row.merchant_normalized);
      const newerCharge =
        det != null &&
        prev.next_charge_date != null &&
        det.next_charge_date > prev.next_charge_date;
      const lifecycle_state =
        prev.lifecycle_state === "ended" &&
        prev.user_correction == null &&
        newerCharge
          ? "reopened"
          : (prev.lifecycle_state ?? "active");

      return {
        ...row,
        merchant_key: prev.merchant_key ?? null,
        billing_channel: prev.billing_channel ?? null,
        lifecycle_state,
        user_correction: prev.user_correction ?? null,
        amount_model: prev.amount_model ?? null,
        confidence: prev.confidence ?? null,
        // next_expected_at is detector-owned only for active rows; preserved otherwise.
        next_expected_at:
          lifecycle_state === "active"
            ? row.next_charge_date
            : (prev.next_expected_at ?? null),
      };
    }
  );
  if (rows.length > 0) {
    const { error: upsertError } = await supabase
      .from("recurring")
      .upsert(rows, { onConflict: "user_id,merchant_normalized" });
    if (upsertError) throw upsertError;
  }
  return { detected: detected.length };
}

export async function POST() {
  if (!isPlaidConfigured()) {
    return NextResponse.json({ error: "Plaid is not configured yet." }, { status: 503 });
  }

  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Service-role client for all DB work below: plaid_items SELECT is revoked
  // for anon/authenticated by design (token column), and this pipeline reads
  // the encrypted token. Auth was verified above; RLS is bypassed server-side.
  const db = createServiceSupabase();

  try {
    const { data: items, error } = await db
      .from("plaid_items")
      .select("id, access_token_encrypted, cursor")
      .eq("user_id", user.id)
      .eq("status", "active");
    if (error) throw error;

    const results = [];
    for (const item of items ?? []) {
      results.push(await syncOneItem(db, user.id, item));
    }

    // Refresh recurring charges from the ledger. Best-effort by design:
    // the transactions are safely stored and cursors advanced already,
    // so a detector failure must not turn the whole sync into a 502.
    let recurring: { detected: number; error: string | null } = { detected: 0, error: null };
    try {
      recurring = { ...(await refreshRecurring(db, user.id)), error: null };
    } catch (e) {
      console.error("recurring refresh failed (non-fatal)", e);
      recurring = { detected: 0, error: "detector failed; transactions are safe" };
    }
    return NextResponse.json({ ok: true, items: results, recurring });
  } catch (e) {
    console.error("sync failed", e);
    return NextResponse.json(
      { error: "Sync didn't finish — nothing was half-saved, try again." },
      { status: 502 }
    );
  }
}
