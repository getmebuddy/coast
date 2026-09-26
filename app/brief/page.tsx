"use client";

/**
 * Brief tab — the morning brief, now with the attention list on top.
 * Scannable in ~30 seconds, calm plain English.
 * Signed-out -> labeled demo brief with demo findings. Signed-in -> real
 * brief plus routine findings assembled from the user's ledger; the server
 * logs morning_brief_viewed with the mode label and advances read state
 * only after successful assembly.
 *
 * Routines only watch and tell: every finding can be resolved, dismissed,
 * or snoozed. Nothing here moves money or contacts anyone.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Brief } from "@/lib/brief";
import { formatUSD } from "@/lib/fire";
import { ROUTINE_REGISTRY } from "@/lib/routines";
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

interface EvidenceTxn {
  id: string;
  merchant: string;
  amount_cents: number;
  date: string;
}

interface Finding {
  id: string;
  routine_key: string;
  kind: string;
  title: string;
  detail: string;
  impact_cents: number;
  evidence: { transactions: EvidenceTxn[]; [key: string]: unknown };
  status: string;
  snoozed_until: string | null;
  created_at: string;
}

interface RoutineRow {
  key: string;
  name: string;
  enabled: boolean;
}

interface RunRow {
  id: string;
  routine_key: string;
  ran_at: string;
  checked_count: number;
  findings_count: number;
  note: string;
}

interface RefundRow {
  id: string;
  merchant: string;
  amount_cents: number;
  expected_date: string;
  status: "pending" | "matched" | "shortfall";
  created_at: string;
}

const DEMO_FINDINGS: Finding[] = [
  {
    id: "demo-1",
    routine_key: "price_hike",
    kind: "price_hike",
    title: "Netflix raised its price",
    detail:
      "Netflix went from $15.49 to $17.99 a month. That is $30.00 more a year if you keep it.",
    impact_cents: 3000,
    evidence: { transactions: [] },
    status: "open",
    snoozed_until: null,
    created_at: "2026-09-26T08:00:00Z",
  },
  {
    id: "demo-2",
    routine_key: "trial_watch",
    kind: "trial_watch",
    title: "Possible trial: Glow App",
    detail:
      "Glow App charged $1.99 on Sep 1, then $14.99 on Sep 29. If the first was a trial, the paid plan has started at about $14.99 a month.",
    impact_cents: 1499,
    evidence: {
      transactions: [
        { id: "d1", merchant: "Glow App", amount_cents: -199, date: "2026-09-01" },
        { id: "d2", merchant: "Glow App", amount_cents: -1499, date: "2026-09-29" },
      ],
    },
    status: "open",
    snoozed_until: null,
    created_at: "2026-09-26T08:00:00Z",
  },
  {
    id: "demo-3",
    routine_key: "fee_sweep",
    kind: "fee_sweep",
    title: "Fees added up this month",
    detail: "$60.00 in fees over the last 30 days across 2 charges.",
    impact_cents: 6000,
    evidence: { transactions: [] },
    status: "open",
    snoozed_until: null,
    created_at: "2026-09-26T08:00:00Z",
  },
];

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

function FindingCard({
  finding,
  interactive,
  onAction,
}: {
  finding: Finding;
  interactive: boolean;
  onAction: (id: string, action: "resolve" | "dismiss" | "snooze") => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const txns = finding.evidence.transactions ?? [];
  return (
    <div className="rounded-lg bg-[var(--surface-secondary)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[length:var(--type-body-size)] font-semibold">{finding.title}</p>
          <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            {finding.detail}
          </p>
        </div>
        {finding.impact_cents > 0 && (
          <span className="tnum shrink-0 rounded-full bg-[var(--signal-warning-soft)] px-2 py-0.5 text-[length:var(--type-micro-size)] font-semibold text-[var(--signal-warning)]">
            {formatUSD(finding.impact_cents)}
          </span>
        )}
      </div>
      {txns.length > 0 && (
        <button
          onClick={() => setShowEvidence((v) => !v)}
          className="mt-2 text-[length:var(--type-micro-size)] font-semibold text-[var(--accent-progress)]"
        >
          {showEvidence ? "Hide evidence" : `See evidence (${txns.length})`}
        </button>
      )}
      {showEvidence && (
        <ul className="mt-2 space-y-1 border-t border-[var(--border-subtle)] pt-2">
          {txns.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between text-[length:var(--type-caption-size)] text-[var(--text-secondary)]"
            >
              <span>
                {t.merchant} · {t.date}
              </span>
              <span className="tnum font-semibold">{formatUSD(t.amount_cents)}</span>
            </li>
          ))}
        </ul>
      )}
      {interactive && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => onAction(finding.id, "resolve")}
            className="rounded-full bg-[var(--accent-progress)] px-3 py-1.5 text-[length:var(--type-micro-size)] font-semibold text-white"
          >
            Done
          </button>
          <button
            onClick={() => onAction(finding.id, "snooze")}
            className="rounded-full bg-[var(--surface-card)] px-3 py-1.5 text-[length:var(--type-micro-size)] font-semibold text-[var(--text-secondary)]"
          >
            Snooze 7 days
          </button>
          <button
            onClick={() => onAction(finding.id, "dismiss")}
            className="rounded-full px-3 py-1.5 text-[length:var(--type-micro-size)] font-semibold text-[var(--text-micro)]"
          >
            Not for me
          </button>
        </div>
      )}
    </div>
  );
}

export default function BriefPage() {
  const [env, setEnv] = useState<BriefEnvelope | null>(null);
  const [error, setError] = useState(false);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [routines, setRoutines] = useState<RoutineRow[] | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [refunds, setRefunds] = useState<RefundRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [refundMerchant, setRefundMerchant] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundDate, setRefundDate] = useState("");
  const [refundError, setRefundError] = useState("");

  async function load() {
    setError(false);
    try {
      const res = await fetch("/api/brief", { cache: "no-store" });
      if (!res.ok) throw new Error("brief failed");
      const data = (await res.json()) as BriefEnvelope;
      if (data.mode === "error") throw new Error("brief assembly failed");
      setEnv(data);
      if (!data.demo) {
        void loadRoutines();
      }
    } catch {
      setError(true);
    }
  }

  async function loadRoutines(runFirst = true) {
    try {
      if (runFirst) {
        setChecking(true);
        await fetch("/api/routines", { method: "POST", cache: "no-store" }).catch(() => {});
        setChecking(false);
      }
      const [fRes, rRes, runsRes, refRes] = await Promise.all([
        fetch("/api/routines/findings", { cache: "no-store" }),
        fetch("/api/routines", { cache: "no-store" }),
        fetch("/api/routines/runs", { cache: "no-store" }),
        fetch("/api/routines/refunds", { cache: "no-store" }),
      ]);
      if (fRes.ok) setFindings(((await fRes.json()) as { findings: Finding[] }).findings);
      if (rRes.ok) setRoutines(((await rRes.json()) as { routines: RoutineRow[] }).routines);
      if (runsRes.ok) setRuns(((await runsRes.json()) as { runs: RunRow[] }).runs.slice(0, 6));
      if (refRes.ok) setRefunds(((await refRes.json()) as { refunds: RefundRow[] }).refunds);
    } catch {
      // Routines are additive; a failure here never breaks the brief.
    }
  }

  async function actOnFinding(id: string, action: "resolve" | "dismiss" | "snooze") {
    try {
      const res = await fetch(`/api/routines/findings/${id}/${action}`, {
        method: "POST",
        cache: "no-store",
      });
      if (res.ok) await loadRoutines(false);
    } catch {
      // non-fatal
    }
  }

  async function toggleRoutine(key: string, enabled: boolean) {
    try {
      const res = await fetch(`/api/routines/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) await loadRoutines(false);
    } catch {
      // non-fatal
    }
  }

  async function registerRefund(e: React.FormEvent) {
    e.preventDefault();
    setRefundError("");
    const dollars = Number(refundAmount);
    if (!refundMerchant.trim()) {
      setRefundError("Add the merchant name.");
      return;
    }
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setRefundError("Add the amount you expect back.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(refundDate)) {
      setRefundError("Pick the date you expect it.");
      return;
    }
    try {
      const res = await fetch("/api/routines/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant: refundMerchant.trim(),
          amount_cents: Math.round(dollars * 100),
          expected_date: refundDate,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setRefundMerchant("");
      setRefundAmount("");
      setRefundDate("");
      const refRes = await fetch("/api/routines/refunds", { cache: "no-store" });
      if (refRes.ok) setRefunds(((await refRes.json()) as { refunds: RefundRow[] }).refunds);
    } catch {
      setRefundError("Could not save that refund. Try again.");
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
  const signedIn = !env.demo;
  const attention = signedIn ? findings : DEMO_FINDINGS;

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

      {attention && attention.length > 0 && (
        <Section title="Needs your attention">
          {env.demo && (
            <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
              Demo data. Sign in to see your own findings.
            </p>
          )}
          {attention.map((f) => (
            <FindingCard key={f.id} finding={f} interactive={signedIn} onAction={actOnFinding} />
          ))}
          {checking && (
            <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
              Checking your latest activity…
            </p>
          )}
        </Section>
      )}

      {brief.quiet && (!attention || attention.length === 0) && (
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

      <Section title="Routines">
        <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          {signedIn
            ? "Coast checks your money on a schedule. Routines only watch and tell you what they find. Nothing here moves money or contacts anyone."
            : "Routines watch your money and flag what matters. Sign in to turn yours on."}
        </p>
        {signedIn && routines && (
          <div className="space-y-2">
            {ROUTINE_REGISTRY.map((reg) => {
              const row = routines.find((r) => r.key === reg.key);
              const enabled = row?.enabled ?? true;
              return (
                <div key={reg.key} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[length:var(--type-body-size)]">{reg.name}</p>
                    <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">{reg.description}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={enabled}
                    aria-label={reg.name}
                    onClick={() => toggleRoutine(reg.key, !enabled)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      enabled ? "bg-[var(--accent-progress)]" : "bg-[var(--ring-track)]"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                        enabled ? "left-[22px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {signedIn && (
          <div className="border-t border-[var(--border-subtle)] pt-3">
            <p className="text-[length:var(--type-body-size)] font-semibold">Waiting on money?</p>
            <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              Returned something or expecting a refund? Coast will watch for it and tell you if it arrives short.
            </p>
            <form onSubmit={registerRefund} className="mt-3 space-y-2">
              <div className="flex gap-2">
                <input
                  value={refundMerchant}
                  onChange={(e) => setRefundMerchant(e.target.value)}
                  placeholder="Merchant"
                  aria-label="Merchant"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-sm"
                />
                <input
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  placeholder="$ amount"
                  aria-label="Expected amount in dollars"
                  inputMode="decimal"
                  className="w-24 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-sm"
                />
                <input
                  value={refundDate}
                  onChange={(e) => setRefundDate(e.target.value)}
                  type="date"
                  aria-label="Expected date"
                  className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-sm"
                />
              </div>
              {refundError && (
                <p className="text-[length:var(--type-caption-size)] text-[var(--signal-warning)]">{refundError}</p>
              )}
              <button
                type="submit"
                className="rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
              >
                Watch this refund
              </button>
            </form>
            {refunds && refunds.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {refunds.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between text-[length:var(--type-caption-size)]"
                  >
                    <span>
                      {r.merchant} · {formatUSD(r.amount_cents)} · by {r.expected_date}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[length:var(--type-micro-size)] font-semibold ${
                        r.status === "matched"
                          ? "bg-[var(--accent-progress-soft)] text-[var(--accent-progress)]"
                          : r.status === "shortfall"
                            ? "bg-[var(--signal-warning-soft)] text-[var(--signal-warning)]"
                            : "bg-[var(--surface-secondary)] text-[var(--text-secondary)]"
                      }`}
                    >
                      {r.status === "matched" ? "received" : r.status === "shortfall" ? "short" : "watching"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {signedIn && runs && runs.length > 0 && (
          <div className="border-t border-[var(--border-subtle)] pt-3">
            <p className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
              Recent checks
            </p>
            <ul className="mt-2 space-y-1">
              {runs.map((run) => {
                const name = ROUTINE_REGISTRY.find((r) => r.key === run.routine_key)?.name ?? run.routine_key;
                return (
                  <li
                    key={run.id}
                    className="flex items-center justify-between text-[length:var(--type-caption-size)] text-[var(--text-secondary)]"
                  >
                    <span>
                      {name} · {run.checked_count} transactions scanned
                    </span>
                    <span className="tnum">
                      {run.findings_count === 0
                        ? "all clear"
                        : `${run.findings_count} new finding${run.findings_count === 1 ? "" : "s"}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Section>

      {!missing.includes("budget") && (
        <div className="pt-1">
          <ShareCard brief={brief} />
        </div>
      )}
    </div>
  );
}
