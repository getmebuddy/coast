"use client";

/**
 * Brief tab — the morning brief. Scannable in ~30 seconds, calm plain English.
 * Signed-out -> labeled demo brief. Signed-in -> real brief assembled from the
 * user's ledger; the server logs morning_brief_viewed with the mode label and
 * advances read state only after successful assembly.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Brief } from "@/lib/brief";
import { formatUSD } from "@/lib/fire";
import ShareCard from "../components/ShareCard";
import DemoBanner from "../components/DemoBanner";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
      <h2 className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
        {title}
      </h2>
      <div className="mt-3 space-y-2.5">{children}</div>
    </section>
  );
}

interface BriefEnvelope {
  mode: string;
  demo?: boolean;
  support_code?: string;
  data: { brief: Brief; missing: string[] };
  missing: string[];
}

function SetupActions({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  const links: Array<{ key: string; href: string; label: string }> = [];
  if (missing.includes("number")) links.push({ key: "number", href: "/number", label: "Set your Number" });
  if (missing.includes("budget")) links.push({ key: "budget", href: "/budgets", label: "Set this month's budget" });
  if (missing.includes("bank")) links.push({ key: "bank", href: "/", label: "Connect a bank" });
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((l) => (
        <Link
          key={l.key}
          href={l.href}
          className="rounded-full bg-[var(--surface-secondary)] px-4 py-2 text-sm font-semibold text-[var(--accent-progress)]"
        >
          {l.label} →
        </Link>
      ))}
    </div>
  );
}

export default function BriefPage() {
  const [env, setEnv] = useState<BriefEnvelope | null>(null);
  const [error, setError] = useState(false);

  async function load() {
    setError(false);
    try {
      const res = await fetch("/api/brief", { cache: "no-store" });
      if (!res.ok) throw new Error("brief failed");
      const data = (await res.json()) as BriefEnvelope;
      if (data.mode === "error") throw new Error("brief assembly failed");
      setEnv(data);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <div className="pt-10 space-y-4">
        <p className="text-[length:var(--type-title-size)] font-semibold">We couldn't load your brief.</p>
        <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Your data is safe — try again in a moment.
        </p>
        <button
          onClick={load}
          className="rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!env) {
    return (
      <div className="space-y-4 pt-2" aria-label="Loading your brief">
        {[1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-28" />
        ))}
      </div>
    );
  }

  if (env.mode === "unavailable" || env.mode === "setup" || env.mode === "syncing") {
    const copy =
      env.mode === "setup"
        ? "Connect a bank to start receiving your morning brief."
        : env.mode === "syncing"
          ? "Your first transactions are syncing — your brief will appear here."
          : "Your brief is temporarily unavailable. Please check back shortly.";
    return (
      <div className="pt-10 space-y-4">
        <p className="text-[length:var(--type-title-size)] font-semibold">Your brief isn't ready yet.</p>
        <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">{copy}</p>
        {env.mode === "setup" && (
          <Link href="/" className="inline-block rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white">
            Go to Home →
          </Link>
        )}
      </div>
    );
  }

  const brief = env.data.brief;
  const missing = env.data.missing;
  const paceOver = brief.budgetSpentCents > brief.budgetExpectedCents;

  return (
    <div className="space-y-5">
      {env.demo && <DemoBanner />}

      <div>
        <h1 className="text-[length:var(--type-title-size)] font-bold">{brief.greeting}.</h1>
        <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Here's your money, in about 30 seconds.
        </p>
      </div>

      <SetupActions missing={missing} />

      {brief.quiet && (
        <div className="rounded-xl bg-[var(--accent-progress-soft)] p-6">
          <p className="text-[length:var(--type-body-size)] text-[var(--text-primary)]">
            Nothing new since yesterday — quiet mornings are good.
          </p>
        </div>
      )}

      {brief.newActivity.length > 0 && (
        <Section title="New activity">
          {brief.newActivity.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[length:var(--type-body-size)]">
                  {a.merchant}
                  {a.pending && (
                    <span className="ml-2 rounded-full bg-[var(--signal-warning-soft)] px-2 py-0.5 text-[length:var(--type-micro-size)] text-[var(--signal-warning)]">
                      pending
                    </span>
                  )}
                </p>
                <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)] capitalize">{a.kind}</p>
              </div>
              <span className={`tnum font-semibold ${a.amountCents < 0 ? "text-[var(--text-primary)]" : "text-[var(--accent-progress)]"}`}>
                {formatUSD(a.amountCents)}
              </span>
            </div>
          ))}
          <p className="pt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            {formatUSD(brief.newActivityTotalCents)} out since yesterday.
            {brief.pendingCount > 0 && ` ${brief.pendingCount} still pending.`}
          </p>
        </Section>
      )}

      {brief.billsDue.length > 0 && (
        <Section title="Bills due this week">
          {brief.billsDue.map((b) => (
            <div key={b.merchant} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[length:var(--type-body-size)]">{b.merchant}</p>
                <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">due {b.dueDate}</p>
              </div>
              <span className="tnum font-semibold">{formatUSD(b.amountCents)}</span>
            </div>
          ))}
          <p className="pt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            {formatUSD(brief.billsDueTotalCents)} committed this week.
          </p>
        </Section>
      )}

      {!missing.includes("budget") && (
        <Section title={`${brief.budgetMonth} budget pace`}>
          <div className="h-2.5 overflow-hidden rounded-full bg-[var(--ring-track)]">
            <div
              className={`h-full rounded-full ${paceOver ? "bg-[var(--signal-warning)]" : "bg-[var(--accent-progress)]"}`}
              style={{ width: `${brief.budgetLimitCents > 0 ? Math.min(100, (brief.budgetSpentCents / brief.budgetLimitCents) * 100) : 0}%` }}
            />
          </div>
          <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            {formatUSD(brief.budgetSpentCents)} spent of {formatUSD(brief.budgetLimitCents)}.{" "}
            {paceOver
              ? `Running ${formatUSD(brief.budgetSpentCents - brief.budgetExpectedCents)} ahead of pace — easy does it.`
              : `${formatUSD(brief.budgetExpectedCents - brief.budgetSpentCents)} under pace. Nicely done.`}
          </p>
        </Section>
      )}

      {brief.priceChanges.length > 0 && (
        <Section title="Subscription watch">
          {brief.priceChanges.map((p) => (
            <div key={p.merchant} className="flex items-center justify-between gap-3">
              <p className="text-[length:var(--type-body-size)]">
                {p.merchant}{" "}
                <span className="tnum text-[var(--text-secondary)]">
                  {p.prevAmountCents !== null ? formatUSD(p.prevAmountCents) : ""} → {formatUSD(p.amountCents)}
                </span>
              </p>
              <span className="rounded-full bg-[var(--signal-warning-soft)] px-2 py-0.5 text-[length:var(--type-micro-size)] text-[var(--signal-warning)]">
                price up
              </span>
            </div>
          ))}
          <p className="pt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            {formatUSD(brief.monthlyRecurringCents)} a month across your subscriptions.
          </p>
        </Section>
      )}

      {!missing.includes("number") ? (
        <Section title="One line on your number">
          <p className="text-[length:var(--type-body-size)] text-[var(--text-primary)]">{brief.fireNudge}</p>
        </Section>
      ) : null}

      {!missing.includes("budget") && (
        <div className="pt-1">
          <ShareCard brief={brief} />
        </div>
      )}
    </div>
  );
}
