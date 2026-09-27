import { beforeEach, describe, expect, it } from "vitest";
import { buildLogoBackfillRows, decryptAccessToken, encryptAccessToken, mapPlaidAccountType, toAccountUpsertRow } from "./plaid";
import { AccountSubtype, AccountType, type AccountBase } from "plaid";

function meta(overrides: Partial<AccountBase> = {}): AccountBase {
  return {
    account_id: "plaid-acct-1",
    name: "Chase Checking",
    official_name: "Chase Total Checking",
    type: "depository",
    subtype: "checking",
    mask: "1234",
    balances: {
      available: 1820.55,
      current: 1842.0,
      limit: null,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    ...overrides,
  } as AccountBase;
}

// ---------- mapPlaidAccountType ----------

describe("mapPlaidAccountType", () => {
  it("maps depository checking/savings", () => {
    expect(mapPlaidAccountType("depository", "checking")).toBe("checking");
    expect(mapPlaidAccountType("depository", "savings")).toBe("savings");
    expect(mapPlaidAccountType("depository", "hsa")).toBe("checking");
  });

  it("maps credit, investment, loan", () => {
    expect(mapPlaidAccountType("credit", "credit card")).toBe("credit");
    expect(mapPlaidAccountType("investment", "brokerage")).toBe("investment");
    expect(mapPlaidAccountType("loan", "auto")).toBe("loan");
  });

  it("defaults unknown/missing types to checking rather than dropping", () => {
    expect(mapPlaidAccountType("other", "other")).toBe("checking");
    expect(mapPlaidAccountType(null, null)).toBe("checking");
    expect(mapPlaidAccountType(undefined, undefined)).toBe("checking");
  });

  it("is case-insensitive", () => {
    expect(mapPlaidAccountType("Depository", "Savings")).toBe("savings");
    expect(mapPlaidAccountType("CREDIT", "CREDIT CARD")).toBe("credit");
  });
});

// ---------- toAccountUpsertRow ----------

describe("toAccountUpsertRow", () => {
  const NOW = "2026-09-21T00:00:00.000Z";

  it("maps full Plaid metadata with integer-cent balances", () => {
    const row = toAccountUpsertRow("user-1", "item-1", "plaid-acct-1", meta(), NOW);
    expect(row).toEqual({
      user_id: "user-1",
      plaid_item_id: "item-1",
      plaid_account_id: "plaid-acct-1",
      name: "Chase Checking",
      official_name: "Chase Total Checking",
      type: "checking",
      subtype: "checking",
      mask: "1234",
      balance_cents: 184200,
      available_cents: 182055,
      updated_at: NOW,
    });
  });

  it("maps a credit card account", () => {
    const row = toAccountUpsertRow(
      "user-1",
      "item-1",
      "plaid-acct-2",
      meta({
        account_id: "plaid-acct-2",
        name: "Sapphire",
        official_name: null,
        type: AccountType.Credit,
        subtype: AccountSubtype.CreditCard,
        mask: "9999",
        balances: { available: 5000, current: 3210.0, limit: 15000 } as AccountBase["balances"],
      }),
      NOW
    );
    expect(row.type).toBe("credit");
    expect(row.balance_cents).toBe(321000); // Plaid convention: positive = owed
    expect(row.official_name).toBeNull();
  });

  it("degrades gracefully when metadata is missing", () => {
    const row = toAccountUpsertRow("user-1", "item-1", "plaid-acct-9", undefined, NOW);
    expect(row.name).toBe("plaid-acct-9"); // id as name, never dropped
    expect(row.type).toBe("checking");
    expect(row.balance_cents).toBe(0);
    expect(row.available_cents).toBeNull();
    expect(row.mask).toBeNull();
  });

  it("handles null balances", () => {
    const row = toAccountUpsertRow(
      "user-1",
      "item-1",
      "plaid-acct-3",
      meta({ balances: { available: null, current: null } as AccountBase["balances"] }),
      NOW
    );
    expect(row.balance_cents).toBe(0);
    expect(row.available_cents).toBeNull();
  });
});

describe("access token encryption", () => {
  beforeEach(() => {
    process.env.PLAID_SECRET = "test-secret-for-unit-tests";
  });

  it("round-trips through encrypt -> decrypt", () => {
    const token = "access-sandbox-abc123";
    expect(decryptAccessToken(encryptAccessToken(token))).toBe(token);
  });

  it("serializes as a \\x-prefixed hex string (PostgREST bytea compatible)", () => {
    const stored = encryptAccessToken("access-sandbox-abc123");
    expect(typeof stored).toBe("string");
    expect(stored.startsWith("\\x")).toBe(true);
    expect(stored.slice(2)).toMatch(/^[0-9a-f]+$/);
    // Must survive JSON round-trip (supabase-js sends rows as JSON).
    expect(decryptAccessToken(JSON.parse(JSON.stringify(stored)))).toBe("access-sandbox-abc123");
  });

  it("produces unique ciphertexts for the same plaintext (random IV)", () => {
    const a = encryptAccessToken("same-token");
    const b = encryptAccessToken("same-token");
    expect(a).not.toBe(b);
    expect(decryptAccessToken(a)).toBe("same-token");
    expect(decryptAccessToken(b)).toBe("same-token");
  });
});

// ---------- buildLogoBackfillRows ----------

describe("buildLogoBackfillRows", () => {
  it("maps non-null Plaid logos to backfill rows", () => {
    const rows = buildLogoBackfillRows("user-1", [
      { transaction_id: "tx-1", logo_url: "https://plaid.com/logo1.png" },
      { transaction_id: "tx-2", logo_url: null },
      { transaction_id: "tx-3" },
      { transaction_id: "tx-4", logo_url: "" },
    ]);
    expect(rows).toEqual([
      {
        user_id: "user-1",
        source: "plaid",
        source_id: "tx-1",
        logo_url: "https://plaid.com/logo1.png",
      },
    ]);
  });

  it("returns an empty array when nothing carries a logo", () => {
    expect(buildLogoBackfillRows("user-1", [])).toEqual([]);
    expect(
      buildLogoBackfillRows("user-1", [{ transaction_id: "tx-1", logo_url: null }])
    ).toEqual([]);
  });

  it("keeps every transaction's own logo (no cross-wiring)", () => {
    const rows = buildLogoBackfillRows("user-1", [
      { transaction_id: "tx-a", logo_url: "https://a.png" },
      { transaction_id: "tx-b", logo_url: "https://b.png" },
    ]);
    expect(rows.map((r) => [r.source_id, r.logo_url])).toEqual([
      ["tx-a", "https://a.png"],
      ["tx-b", "https://b.png"],
    ]);
  });
});
