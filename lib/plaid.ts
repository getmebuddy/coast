/**
 * Plaid client factory — sandbox-first.
 * Reads PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV from env only.
 * Never import this into client components: tokens live here.
 */

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

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
