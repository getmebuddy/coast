/**
 * Regenerate the `recurring` block and `monthlyRecurringCents` in
 * lib/data/demo.json from the real detector (lib/recurring.ts).
 *
 * The demo JSON used to carry a hand-written recurring list ("what the
 * detector would find"). Now the detector exists, so this script makes the
 * seed data match it exactly. Run with:
 *
 *   node scripts/regen-demo-recurring.ts
 *
 * Existing per-merchant `category` values are preserved; everything else
 * comes from the detector. `amount_cents_avg` in the demo block carries the
 * latest charge (the expected next bill), matching what the Brief shows.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectRecurring,
  totalMonthlyRecurringCents,
} from "../lib/recurring.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "lib", "data", "demo.json");

const demo = JSON.parse(readFileSync(path, "utf8"));

// Categories come from the ledger itself (mode category per merchant),
// not from any previous hand-written block.
const categoryByMerchant = new Map<string, string>();
{
  const votes = new Map<string, Map<string, number>>();
  for (const t of demo.transactions as Array<Record<string, unknown>>) {
    const m = t.merchant as string;
    const c = t.category as string;
    if (!votes.has(m)) votes.set(m, new Map());
    const vm = votes.get(m)!;
    vm.set(c, (vm.get(c) ?? 0) + 1);
  }
  for (const [m, vm] of votes) {
    let best = "Other";
    let bestN = -1;
    for (const [c, n] of vm) {
      if (n > bestN) {
        best = c;
        bestN = n;
      }
    }
    categoryByMerchant.set(m, best);
  }
}

const detected = detectRecurring(
  (demo.transactions as Array<Record<string, unknown>>).map((t) => ({
    merchant: t.merchant as string,
    amount_cents: t.amount_cents as number,
    date: t.date as string,
    kind: t.kind as string,
    pending: t.pending as boolean,
  }))
);

demo.recurring = detected.map((d) => ({
  merchant: d.merchant,
  amount_cents_avg: d.amount_cents,
  cadence: d.cadence,
  next_charge_date: d.next_charge_date,
  price_changed: d.price_changed,
  prev_amount_cents: d.prev_amount_cents,
  category: categoryByMerchant.get(d.merchant) ?? "Other",
  charges_count: d.charges_count,
  monthly_cents: d.monthly_cents,
}));
demo.monthlyCommittedBillsCents = totalMonthlyRecurringCents(detected);

writeFileSync(path, JSON.stringify(demo, null, 2) + "\n", "utf8");

console.log(`detected ${detected.length} recurring merchants`);
for (const d of detected) {
  console.log(
    `  ${d.merchant} | ${d.cadence} | n=${d.charges_count} | latest=${d.amount_cents} | ` +
      `next=${d.next_charge_date} | changed=${d.price_changed}` +
      (d.prev_amount_cents != null ? ` prev=${d.prev_amount_cents}` : "") +
      ` | mo=${d.monthly_cents}`
  );
}
console.log(`monthlyCommittedBillsCents = ${demo.monthlyCommittedBillsCents}`);
