/**
 * Ledger normalization + classification.
 * Money: integer cents. Plaid amounts are positive = money OUT (debit);
 * Coast stores negative = money out, positive = money in.
 *
 * Transfers and credit-card payments NEVER count as spending.
 */

export type TransactionKind = "income" | "expense" | "transfer" | "refund" | "fee";

/** Strip store numbers / noise: "AMZN MKTP US*2R..." -> "Amazon". */
export function normalizeMerchant(raw: string): string {
  let s = raw.toUpperCase().trim();
  // drop trailing *codes, store numbers, and trailing digits
  s = s.replace(/\*[A-Z0-9]{2,}.*$/, "").replace(/\s*#\d+.*$/, "").replace(/\s+\d{3,}.*$/, "");
  const aliases: Record<string, string> = {
    AMZN: "Amazon",
    "AMAZON.COM": "Amazon",
    WFM: "Whole Foods",
    "WHOLEFDS": "Whole Foods",
    TRADER: "Trader Joe's",
    TJX: "TJ Maxx",
    TGT: "Target",
    COSTCO: "Costco",
    NETFLIX: "Netflix",
    SPOTIFY: "Spotify",
    "APPLE.COM/BILL": "Apple",
    UBER: "Uber",
    LYFT: "Lyft",
    DOORDASH: "DoorDash",
    "SHELL OIL": "Shell",
    CHEVRON: "Chevron",
  };
  for (const [k, v] of Object.entries(aliases)) {
    if (s.startsWith(k)) return v;
  }
  // Title-case the remainder
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Classify a transaction. Positive plaidAmount = money OUT of the account (Plaid convention).
 * Returns the Coast signed amount (negative = out, positive = in) plus the kind.
 */
export function classifyTransaction(args: {
  plaidAmount: number; // Plaid convention: positive = outflow
  merchantNormalized: string;
  plaidCategory?: string[] | null;
  personalFinanceCategoryPrimary?: string | null;
}): { amountCents: number; kind: TransactionKind } {
  const { plaidAmount, merchantNormalized, personalFinanceCategoryPrimary } = args;
  const cents = Math.round(plaidAmount * 100);
  const amountCents = -cents; // Coast convention: negative = out

  const name = merchantNormalized.toLowerCase();
  const pfc = (personalFinanceCategoryPrimary || "").toLowerCase();

  const looksLikeTransfer =
    pfc === "transfer_in" ||
    pfc === "transfer_out" ||
    /\b(venmo|cash app|zelle|transfer|ach transfer|wire)\b/.test(name) ||
    /\b(chase|amex|sofi|schwab|vanguard|fidelity) (credit|card|payment)\b/.test(name) ||
    /credit card payment/.test(name) ||
    /autopay/.test(name);

  if (looksLikeTransfer) return { amountCents, kind: "transfer" };
  if (pfc === "bank_fees" || /overdraft|late fee|annual fee/.test(name)) return { amountCents, kind: "fee" };
  if (amountCents > 0) {
    // money in: refund vs income — refunds pair with a recent outflow at the same merchant
    if (/refund|reversal|credit adjustment/.test(name)) return { amountCents, kind: "refund" };
    return { amountCents, kind: "income" };
  }
  return { amountCents, kind: "expense" };
}

/** Default merchant -> category map (used before user rules/overrides). */
const DEFAULT_CATEGORY_MAP: Array<[RegExp, string]> = [
  [/whole foods|trader joe|kroger|safeway|heb|costco|aldi/i, "Groceries"],
  [/doordash|ubereats|grubhub|chipotle|sweetgreen|starbucks|restaurant|cafe|pizza|sushi|taco/i, "Dining"],
  [/netflix|spotify|hulu|disney|hbo|apple tv|youtube premium|patreon/i, "Subscriptions"],
  [/shell|chevron|exxon|bp |circle k|parking|toll/i, "Transport"],
  [/uber|lyft/i, "Transport"],
  [/delta|united|american airlines|southwest|airbnb|hotel|marriott|hertz/i, "Travel"],
  [/amazon|target|walmart|tj maxx|costco|best buy/i, "Shopping"],
  [/cvs|walgreens|kaiser|dentist|doctor|pharmacy/i, "Health"],
  [/electric|water|gas bill|internet|comcast|xfinity|verizon|t-mobile|insurance/i, "Bills"],
  [/zillow|rent|landlord|property/i, "Housing"],
];

export function defaultCategory(merchantNormalized: string): string {
  for (const [re, cat] of DEFAULT_CATEGORY_MAP) {
    if (re.test(merchantNormalized)) return cat;
  }
  return "Other";
}

/**
 * Resolve the effective category for a transaction:
 *   overrides (user corrections) > rules (user patterns) > default map.
 * Every user correction becomes a rule automatically (callers persist it).
 */
export function resolveCategory(args: {
  merchantNormalized: string;
  override?: string | null;
  rules: Array<{ matchPattern: string; category: string }>;
}): string {
  if (args.override) return args.override;
  const merchant = args.merchantNormalized.toLowerCase();
  for (const rule of args.rules) {
    if (merchant.includes(rule.matchPattern.toLowerCase())) return rule.category;
  }
  return defaultCategory(args.merchantNormalized);
}

/** Spending = expenses + fees only. Transfers, refunds, income never count. */
export function isSpending(kind: TransactionKind): boolean {
  return kind === "expense" || kind === "fee";
}

/** Stable-ID dedupe key for a Plaid transaction. */
export function stableDedupeKey(userId: string, plaidTransactionId: string): string {
  return `${userId}:plaid:${plaidTransactionId}`;
}
