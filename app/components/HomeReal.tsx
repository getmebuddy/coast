"use client";

/**
 * Signed-in Home. Renders ONLY real user data (or honest missing/error
 * states) from a provenance-tagged envelope. This component — and every
 * module it imports — must have no import path to demo values.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import TrajectoryRing from "./TrajectoryRing";
import CountUp from "./CountUp";
import ConnectBank from "./ConnectBank";
import { formatUSD } from "@/lib/fire";
import { trackPilotEvent } from "@/lib/analytics";
import type { DataEnvelope } from "@/lib/real-data";
import type { HomeData } from "@/lib/real-data-server";

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
      <p className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function SetupCta({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link href={href} className="block">
      <p className="text-[length:var(--type-body-size)] font-semibold text-[var(--accent-progress)]">{title}</p>
      <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">{body}</p>
    </Link>
  );
}

export default function HomeReal({ initial }: { initial: DataEnvelope<HomeData> }) {
  const [env, setEnv] = useState(initial);
  const [retrying, setRetrying] = useState(false);
  const insightFired = useRef(false);

  const { mode, data, missing } = env;

  // First successfully rendered real insight -> first_insight_viewed (labels only).
  useEffect(() => {
    if (insightFired.current) return;
    const hasReal = Object.values(env.provenance).some((p) => p === "real");
    if (hasReal && (mode === "real" || mode === "partial")) {
      insightFired.current = true;
      trackPilotEvent("first_insight_viewed", { surface: "home", mode });
    }
  }, [env, mode]);

  async function retry() {
    setRetrying(true);
    try {
      const res = await fetch("/api/home", { cache: "no-store" });
      if (res.ok) setEnv((await res.json()) as DataEnvelope<HomeData>);
    } finally {
      setRetrying(false);
    }
  }

  if (mode === "error") {
    return (
      <div className="space-y-4 pt-2">
        <Card label="Something went wrong">
          <p className="text-[length:var(--type-body-size)] text-[var(--text-primary)]">
            We couldn't load your dashboard. Your data is safe — this is a display problem, not a data problem.
          </p>
          {env.support_code && (
            <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              Support code: {env.support_code}
            </p>
          )}
          <button
            onClick={retry}
            disabled={retrying}
            className="mt-4 rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {retrying ? "Retrying…" : "Try again"}
          </button>
        </Card>
      </div>
    );
  }

  if (mode === "unavailable") {
    return (
      <div className="space-y-4 pt-2">
        <Card label="Temporarily unavailable">
          <p className="text-[length:var(--type-body-size)] text-[var(--text-primary)]">
            Your dashboard is temporarily unavailable. Please check back shortly.
          </p>
        </Card>
      </div>
    );
  }

  if (mode === "setup") {
    return (
      <div className="space-y-8 pt-2">
        <section aria-label="Welcome" className="space-y-2">
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Let's set up your Coast</h1>
          <p className="text-[length:var(--type-body-size)] text-[var(--text-secondary)]">
            Connect a bank and set your Number to see your real trajectory.
          </p>
        </section>
        <ConnectBank />
        <Card label="Your Number">
          <SetupCta href="/number" title="Set your Number" body="Define the amount that makes work optional." />
        </Card>
      </div>
    );
  }

  if (mode === "syncing") {
    return (
      <div className="space-y-4 pt-2">
        <Card label="Syncing">
          <p className="text-[length:var(--type-body-size)] text-[var(--text-primary)]">
            Your first transactions are syncing. This usually takes a minute — your real data will appear here, never sample data.
          </p>
        </Card>
      </div>
    );
  }

  const { number, budgetLeft, recurring, connection } = data;

  return (
    <div className="space-y-8">
      {/* The Number */}
      {number.provenance === "real" ? (
        <section aria-label="Trajectory" className="space-y-5 pt-2">
          <div>
            <p className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
              The Number
            </p>
            <p className="tnum mt-1 text-3xl font-bold text-[var(--text-hero-number)]">
              {formatUSD(number.targetCents!)}
            </p>
            <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              {number.arrivalLabel
                ? `On track for ${number.arrivalLabel}`
                : "Not on track yet — your plan needs a nudge"}
            </p>
          </div>
          <div className="flex justify-center">
            <TrajectoryRing pct={number.progressPct!} />
          </div>
        </section>
      ) : (
        <div className="pt-2">
          <Card label="The Number">
            <SetupCta href="/number" title="Set your Number" body="Define the amount that makes work optional." />
          </Card>
        </div>
      )}

      {/* Budget left per day */}
      <Card label="Budget left per day">
        {budgetLeft.provenance === "real" && budgetLeft.perDayCents != null ? (
          <>
            <CountUp cents={budgetLeft.perDayCents} className="mt-1 block text-4xl font-bold text-[var(--text-hero-number)]" />
            {budgetLeft.overByCents > 0 ? (
              <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                Over budget by {formatUSD(budgetLeft.overByCents)} this month.
              </p>
            ) : (
              <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                Unspent monthly budget, split over the days left in{" "}
                {new Intl.DateTimeFormat("en-US", { timeZone: env.timezone, month: "long" }).format(new Date(env.as_of))}.
              </p>
            )}
          </>
        ) : (
          <SetupCta href="/budgets" title="Set this month's budget" body="Add a monthly ceiling to unlock your daily figure." />
        )}
      </Card>

      {/* Subscription reveal */}
      <Card label="Subscription reveal">
        {recurring.provenance === "real" && recurring.count > 0 ? (
          <>
            <p className="text-[length:var(--type-body-size)] text-[var(--text-primary)]">
              We found{" "}
              <CountUp cents={recurring.totalMonthlyCents} className="font-bold text-[var(--accent-progress)]" />{" "}
              in <span className="font-bold">{recurring.count}</span> subscriptions.
            </p>
            {recurring.priceHikes.length > 0 && (
              <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                {recurring.priceHikes.length} price{recurring.priceHikes.length === 1 ? "" : "s"} went up — see Subscriptions for details.
              </p>
            )}
          </>
        ) : recurring.learning ? (
          <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            Coast is learning your patterns — recurring charges will appear here once detected.
          </p>
        ) : (
          <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            No subscription data yet.
          </p>
        )}
      </Card>

      {/* Connection status */}
      <Card label="Connected accounts">
        {connection.hasActiveItem ? (
          <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            {connection.institutionCount} institution{connection.institutionCount === 1 ? "" : "s"} connected
            {connection.lastSyncAt
              ? ` · last synced ${new Date(connection.lastSyncAt).toLocaleString()}`
              : ""}
            .
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              No bank connected yet.
            </p>
            <ConnectBank />
          </div>
        )}
      </Card>

      {missing.length > 0 && mode === "partial" && (
        <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Still to set up: {missing.join(", ")}.
        </p>
      )}
    </div>
  );
}
