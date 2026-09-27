"use client";

/**
 * Signed-in spending explorer. Fetches real data from /api/spending and
 * logs one spending_viewed pilot event per page open (range prop is a
 * label, never a monetary value).
 */
import { useEffect, useState } from "react";
import { trackPilotEvent } from "@/lib/analytics";
import type { DataEnvelope } from "@/lib/real-data";
import type { SpendingData } from "@/lib/spending";
import SpendingView from "./SpendingView";

export default function SpendingReal() {
  const [env, setEnv] = useState<DataEnvelope<SpendingData> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/spending", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("spending failed");
        return r.json();
      })
      .then((e) => {
        setEnv(e as DataEnvelope<SpendingData>);
        trackPilotEvent("spending_viewed", { range: "month" });
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed || (env && env.mode === "error")) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Spending</h1>
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <p>We couldn't load your spending.</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!env) {
    return (
      <div className="space-y-4" aria-label="Loading your spending">
        <div className="skeleton h-10 w-48" />
        <div className="skeleton h-64" />
        <div className="skeleton h-28" />
      </div>
    );
  }

  if (env.mode === "setup" || env.mode === "syncing" || env.mode === "unavailable") {
    const copy =
      env.mode === "setup"
        ? "Connect a bank to see your spending broken down."
        : env.mode === "syncing"
          ? "Your first transactions are syncing — your spending view will appear here."
          : "Spending is temporarily unavailable. Please check back shortly.";
    return (
      <div className="pt-10 space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Spending</h1>
        <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">{copy}</p>
      </div>
    );
  }

  return <SpendingView data={env.data} />;
}
