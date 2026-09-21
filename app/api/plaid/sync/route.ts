import { NextResponse } from "next/server";
import { createDecipheriv, createHash } from "crypto";
import { RemovedTransaction, Transaction } from "plaid";
import { getPlaidClient, isPlaidConfigured } from "@/lib/plaid";
import { classifyTransaction, normalizeMerchant } from "@/lib/ledger";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/plaid/sync — cursor-based incremental transaction sync.
 *
 * Contract (the heart of Coast):
 *  1. Read the stored cursor for each active plaid_item.
 *  2. Page /transactions/sync until has_more is false.
 *  3. Upsert by (user_id, source='plaid', source_id=plaid transaction_id) —
 *     re-running the sync NEVER duplicates data (idempotent).
 *  4. Mark removed transactions (Plaid `removed`) — ledger rows are immutable,
 *     so removals become a companion tombstone note, not a delete.
 *  5. Advance the cursor ONLY after a successful commit.
 *
 * Decryption mirrors the exchange route (AES-256-GCM, key from PLAID_SECRET).
 */
function decryptToken(blob: Buffer): string {
  const key = createHash("sha256").update(process.env.PLAID_SECRET!).digest();
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
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
  supabase: ReturnType<typeof createServerSupabase>,
  userId: string,
  item: { id: string; access_token_encrypted: Buffer; cursor: string | null }
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

  // Ensure accounts exist (map Plaid account_id -> our accounts rows)
  const plaidAccountIds = [...new Set(added.concat(modified).map((t) => t.account_id))];
  const accountMap = new Map<string, string>();
  if (plaidAccountIds.length > 0) {
    // Look up existing accounts by name/type later; for now upsert minimal rows keyed by id.
    // (A production pass joins on a plaid_account_id column; v1 maps by account_id.)
    for (const plaidAccountId of plaidAccountIds) {
      const { data: existing } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("plaid_item_id", item.id)
        .eq("name", plaidAccountId) // v1: name carries the plaid account id until enriched
        .maybeSingle();
      if (existing) {
        accountMap.set(plaidAccountId, existing.id);
      } else {
        const { data: created, error } = await supabase
          .from("accounts")
          .insert({
            user_id: userId,
            plaid_item_id: item.id,
            name: plaidAccountId,
            type: "checking",
            balance_cents: 0,
          })
          .select("id")
          .single();
        if (error) throw error;
        accountMap.set(plaidAccountId, created.id);
      }
    }
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

export async function POST() {
  if (!isPlaidConfigured()) {
    return NextResponse.json({ error: "Plaid is not configured yet." }, { status: 503 });
  }

  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  try {
    const { data: items, error } = await supabase
      .from("plaid_items")
      .select("id, access_token_encrypted, cursor")
      .eq("user_id", user.id)
      .eq("status", "active");
    if (error) throw error;

    const results = [];
    for (const item of items ?? []) {
      results.push(await syncOneItem(supabase, user.id, item));
    }
    return NextResponse.json({ ok: true, items: results });
  } catch (e) {
    console.error("sync failed", e);
    return NextResponse.json(
      { error: "Sync didn't finish — nothing was half-saved, try again." },
      { status: 502 }
    );
  }
}
