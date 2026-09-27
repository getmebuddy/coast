"use client";

/**
 * Signed-out spending explorer — clearly labeled demo data only.
 * Built from the same demo ledger the rest of the signed-out app uses.
 */
import { useMemo } from "react";
import { demoFire, demoTransactions } from "@/lib/demo";
import { buildSpendingData, type SpendTxn } from "@/lib/spending";
import SpendingView from "./SpendingView";

export default function SpendingDemo() {
  const data = useMemo(() => {
    const txns: SpendTxn[] = demoTransactions.map((t) => ({
      id: t.id,
      date: t.date,
      merchant: t.merchant,
      amount_cents: t.amount_cents,
      kind: t.kind,
      pending: t.pending,
      category: t.category,
    }));
    const today = new Date().toISOString().slice(0, 10);
    return buildSpendingData(txns, today, Math.round(demoFire.annual_spending_cents / 12));
  }, []);
  return <SpendingView data={data} demo />;
}
