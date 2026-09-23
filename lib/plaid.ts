/**
 * Plaid client factory — sandbox-first.
 * Reads PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV from env only.
 * Never import this into client components: tokens live here.
 */

import { Configuration, PlaidApi, PlaidEnvironments, type AccountBase } from "plaid";

let cached: PlaidApi | null = null;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

export function plaidEnv() {
  const e = (process.env.PLAID_ENV || "sandbox").toLowerCase();
  if (e === "production") return { name: "production", url: PlaidEnvironments.production };
  if (e === "development") return { name: "development", url: PlaidEnvironments.development };
  return { name: "sandbox", url: PlaidEnvironments.sandbox };
}

export function getPlaidClient(): PlaidApi {
  if (cached) return cached;
  const configuration = new Configuration({
    basePath: plaidEnv().url,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": envOrThrow("PLAID_CLIENT_ID"),
        "PLAID-SECRET": envOrThrow("PLAID_SECRET"),
      },
    },
  });
  cached = new PlaidApi(configuration);
  return cached;
}

/** Is Plaid configured in this environment? Used to degrade honestly when keys are absent. */
export function isPlaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

/**
 * Map Plaid's account type/subtype onto Coast's account types.
 * Plaid depository subtypes (checking/savings/...) collapse onto ours;
 * anything unrecognized defaults to checking rather than dropping the account.
 * Pure — safe to unit test without keys.
 */
export function mapPlaidAccountType(
  plaidType: string | null | undefined,
  plaidSubtype: string | null | undefined
): string {
  const t = (plaidType ?? "").toLowerCase();
  const s = (plaidSubtype ?? "").toLowerCase();
  if (t === "depository") return s === "savings" ? "savings" : "checking";
  if (t === "credit") return "credit";
  if (t === "investment") return "investment";
  if (t === "loan") return "loan";
  return "checking";
}

export interface AccountUpsertRow {
  user_id: string;
  plaid_item_id: string;
  plaid_account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balance_cents: number;
  available_cents: number | null;
  updated_at: string;
}

/**
 * Build the `accounts` upsert row from Plaid account metadata.
 * Balances follow the Plaid convention verbatim (integer cents; for credit
 * accounts a positive current balance is the amount owed) and are documented
 * as such on the column. When metadata is missing (account vanished from
 * /accounts/get between calls) the row degrades to the Plaid account id as
 * its name rather than failing the sync. Pure — no I/O.
 */
export function toAccountUpsertRow(
  userId: string,
  itemId: string,
  plaidAccountId: string,
  meta: AccountBase | undefined,
  nowISO: string
): AccountUpsertRow {
  const bal = meta?.balances;
  return {
    user_id: userId,
    plaid_item_id: itemId,
    plaid_account_id: plaidAccountId,
    name: meta?.name ?? plaidAccountId,
    official_name: meta?.official_name ?? null,
    type: mapPlaidAccountType(meta?.type, meta?.subtype),
    subtype: meta?.subtype != null ? String(meta.subtype) : null,
    mask: meta?.mask ?? null,
    balance_cents: bal?.current != null ? Math.round(bal.current * 100) : 0,
    available_cents: bal?.available != null ? Math.round(bal.available * 100) : null,
    updated_at: nowISO,
  };
}

/**
 * Access-token encryption at rest (AES-256-GCM, key derived from PLAID_SECRET).
 * For production, move this to Supabase Vault / a KMS key.
 *
 * IMPORTANT: values are serialized as `\x`-prefixed hex STRINGS, not Buffers.
 * supabase-js sends rows as JSON, and JSON.stringify(Buffer) produces
 * {"type":"Buffer","data":[...]} which PostgREST cannot cast to bytea —
 * passing a Buffer here used to fail every plaid_items insert.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function tokenKey(): Buffer {
  const secret = process.env.PLAID_SECRET;
  if (!secret) throw new Error("Missing required env var: PLAID_SECRET (see .env.example)");
  return createHash("sha256").update(secret).digest();
}

/** Encrypt an access token → `\x`-hex string safe for the bytea column. */
export function encryptAccessToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `\\x${Buffer.concat([iv, tag, enc]).toString("hex")}`;
}

/** Decrypt a `\x`-hex string from the bytea column → the access token. */
export function decryptAccessToken(stored: string): string {
  const blob = Buffer.from(stored.replace(/^\\x/, ""), "hex");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
