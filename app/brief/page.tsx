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
import { demoRecurring } from "@/lib/demo";
import ShareCard from "../components/ShareCard";
import DemoBanner from "../components/DemoBanner";
import MerchantIcon from "../components/MerchantIcon";
import RefreshAccountsButton from "../components/RefreshAccountsButton";

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

interface UpcomingCharge {
  merchant: string;
  logoUrl?: string | null;
  amountCents: number;
  date: string;
  cadence: string;
  inferred: boolean;
}

interface UpcomingPayday {
  amountCents: number;
  date: string;
  cadence: string;
}

interface UpcomingData {
  charges: UpcomingCharge[];
  payday: UpcomingPayday | null;
}

interface BudgetCategoryRow {
  category: string;
  limitCents: number;
  spentCents: number;
  txnCount: number;
  expectedCents: number;
}

interface WatchlistRow {
  id: string;
  name: string;
  target_kind: "merchant" | "category";
  target: string;
  threshold_cents: number;
  created_at: string;
}

/** Signed-out demo upcoming strip, from the demo recurring charges. */
function demoUpcoming(): UpcomingData {
  const today = new Date().toISOString().slice(0, 10);
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 14);
  const horizon = d.toISOString().slice(0, 10);
  const charges = demoRecurring
    .filter((r) => r.next_charge_date >= today && r.next_charge_date <= horizon)
    .map((r) => ({
      merchant: r.merchant,
      amountCents: Math.abs(r.amount_cents_avg),
      date: r.next_charge_date,
      cadence: r.cadence,
      inferred: true,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { charges, payday: null };
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Rank categories for the compact Brief strip: over-limit, near-limit, ahead of pace, then the rest. */
function paceRisk(c: BudgetCategoryRow): number {
  if (c.spentCents > c.limitCents) return 3;
  if (c.limitCents > 0 && c.spentCents / c.limitCents >= 0.8) return 2;
  if (c.spentCents > c.expectedCents) return 1;
  return 0;
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
  const [upcoming, setUpcoming] = useState<UpcomingData | null>(null);
  const [budgetCats, setBudgetCats] = useState<BudgetCategoryRow[] | null>(null);
  const [watchlists, setWatchlists] = useState<WatchlistRow[] | null>(null);
  const [wlName, setWlName] = useState("");
  const [wlKind, setWlKind] = useState<"merchant" | "category">("merchant");
  const [wlTarget, setWlTarget] = useState("");
  const [wlThreshold, setWlThreshold] = useState("");
  const [wlError, setWlError] = useState("");

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
        void loadUpcoming();
        void loadBudgetCats();
        void loadWatchlists();
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

  async function loadUpcoming() {
    try {
      const res = await fetch("/api/upcoming", { cache: "no-store" });
      if (res.ok) setUpcoming(((await res.json()) as { data: UpcomingData }).data);
    } catch {
      // Additive; the brief stands without it.
    }
  }

  async function loadBudgetCats() {
    try {
      const res = await fetch("/api/budgets", { cache: "no-store" });
      if (!res.ok) return;
      const env2 = (await res.json()) as { data?: { categories?: BudgetCategoryRow[] } };
      setBudgetCats(env2.data?.categories ?? []);
    } catch {
      // Additive; the brief stands without it.
    }
  }

  async function loadWatchlists() {
    try {
      const res = await fetch("/api/routines/watchlists", { cache: "no-store" });
      if (res.ok) setWatchlists(((await res.json()) as { watchlists: WatchlistRow[] }).watchlists);
    } catch {
      // Additive; the brief stands without it.
    }
  }

  async function addWatchlist(e: React.FormEvent) {
    e.preventDefault();
    setWlError("");
    if (!wlName.trim()) {
      setWlError("Name your watchlist.");
      return;
    }
    if (!wlTarget.trim()) {
      setWlError(`Add the ${wlKind} to watch.`);
      return;
    }
    const dollars = Number(wlThreshold);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setWlError("Add a monthly limit in dollars.");
      return;
    }
    try {
      const res = await fetch("/api/routines/watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: wlName.trim(),
          target_kind: wlKind,
          target: wlTarget.trim(),
          threshold_dollars: dollars,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setWlName("");
      setWlTarget("");
      setWlThreshold("");
      await loadWatchlists();
    } catch {
      setWlError("Could not save that watchlist. Try again.");
    }
  }

  async function removeWatchlist(id: string) {
    try {
      const res = await fetch(`/api/routines/watchlists/${id}`, { method: "DELETE" });
      if (res.ok) await loadWatchlists();
    } catch {
      // non-fatal
    }
  }

  async function actOnFinding(id: string, action: "resolve" | "dismiss" | "snooze") {    try {
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
  const up = signedIn ? upcoming : demoUpcoming();

  return (
    <div className="space-y-5">
      {env.demo && <DemoBanner />}

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[length:var(--type-title-size)] font-bold">{brief.greeting}.</h1>
          <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            Here's your money, in about 30 seconds.
          </p>
        </div>
        {signedIn && <RefreshAccountsButton onSynced={load} />}
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
              <div className="flex min-w-0 items-center gap-3">
                <MerchantIcon logoUrl={a.logoUrl} merchantName={a.merchant} size={32} />
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

      <Section title="Coming up">
        {env.demo && (
          <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
            Demo data. Sign in to see your own upcoming charges.
          </p>
        )}
        {signedIn && !upcoming ? (
          <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
            Checking what's ahead…
          </p>
        ) : up && (up.charges.length > 0 || up.payday) ? (
          <>
            {up.charges.map((c) => (
              <div key={`${c.merchant}-${c.date}`} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <MerchantIcon logoUrl={c.logoUrl} merchantName={c.merchant} size={32} />
                  <div className="min-w-0">
                    <p className="truncate text-[length:var(--type-body-size)]">{c.merchant}</p>
                    <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
                      expected {shortDate(c.date)} · {c.cadence}
                    </p>
                  </div>
                </div>
                <span className="tnum font-semibold">{formatUSD(c.amountCents)}</span>
              </div>
            ))}
            {up.payday && (
              <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-2.5">
                <div>
                  <p className="text-[length:var(--type-body-size)]">Payday</p>
                  <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
                    expected {shortDate(up.payday.date)} · inferred from your income pattern
                  </p>
                </div>
                <span className="tnum font-semibold text-[var(--accent-progress)]">
                  +{formatUSD(up.payday.amountCents)}
                </span>
              </div>
            )}
            <p className="pt-1 text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
              Estimates from your past charges — dates and amounts can shift.
            </p>
          </>
        ) : (
          <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            No recurring charges detected in the next 14 days.
          </p>
        )}
      </Section>

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
          {signedIn && budgetCats && budgetCats.length > 0 && (
            <div className="mt-4 space-y-2.5 border-t border-[var(--border-subtle)] pt-3">
              {budgetCats
                .slice()
                .sort((a, b) => paceRisk(b) - paceRisk(a))
                .slice(0, 3)
                .map((c) => {
                  const pct = c.limitCents > 0 ? Math.min(100, (c.spentCents / c.limitCents) * 100) : 0;
                  const over = c.spentCents > c.limitCents;
                  const delta = c.spentCents - c.expectedCents;
                  const label = over
                    ? `${formatUSD(c.spentCents - c.limitCents)} over limit`
                    : delta > 0
                      ? `${formatUSD(delta)} ahead of pace`
                      : `${formatUSD(-delta)} under pace`;
                  return (
                    <div key={c.category}>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-[length:var(--type-caption-size)] font-semibold">{c.category}</p>
                        <p
                          className={`text-[length:var(--type-micro-size)] ${
                            over
                              ? "text-[var(--signal-critical)]"
                              : delta > 0
                                ? "text-[var(--signal-warning)]"
                                : "text-[var(--text-micro)]"
                          }`}
                        >
                          {label}
                        </p>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--ring-track)]">
                        <div
                          className={`h-full rounded-full ${
                            over
                              ? "bg-[var(--signal-critical)]"
                              : pct >= 80
                                ? "bg-[var(--signal-warning)]"
                                : "bg-[var(--accent-progress)]"
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              <Link
                href="/budgets"
                className="inline-block pt-1 text-[length:var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
              >
                All budgets →
              </Link>
            </div>
          )}
        </Section>
      )}

      <Link href="/spending" className="block rounded-xl bg-[var(--surface-card)] p-6 elev-1">
        <p className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          Spending
        </p>
        <p className="mt-2 text-[length:var(--type-body-size)] font-semibold">
          {!missing.includes("budget")
            ? `${formatUSD(brief.budgetSpentCents)} out this month — see where it went.`
            : "See where your money went."}
        </p>
        <p className="mt-1 text-[length:var(--type-caption-size)] font-semibold text-[var(--accent-progress)]">
          Open the spending explorer →
        </p>
      </Link>

      {brief.priceChanges.length > 0 && (
        <Section title="Subscription watch">
          {brief.priceChanges.map((p) => (
            <div key={p.merchant} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <MerchantIcon logoUrl={p.logoUrl} merchantName={p.merchant} size={32} />
                <p className="truncate text-[length:var(--type-body-size)]">
                  {p.merchant}{" "}
                  <span className="tnum text-[var(--text-secondary)]">
                    {p.prevAmountCents !== null ? formatUSD(p.prevAmountCents) : ""} → {formatUSD(p.amountCents)}
                  </span>
                </p>
              </div>
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
                    <span className="flex min-w-0 items-center gap-2">
                      <MerchantIcon merchantName={r.merchant} size={24} />
                      <span className="truncate">
                        {r.merchant} · {formatUSD(r.amount_cents)} · by {r.expected_date}
                      </span>
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
        {signedIn && (
          <div className="border-t border-[var(--border-subtle)] pt-3">
            <p className="text-[length:var(--type-body-size)] font-semibold">Watchlists</p>
            <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              Pick a merchant or a category and a monthly limit. Coast tells you when spending crosses
              it — nothing here ever moves money.
            </p>
            <form onSubmit={addWatchlist} className="mt-3 space-y-2">
              <div className="flex gap-2">
                <input
                  value={wlName}
                  onChange={(e) => setWlName(e.target.value)}
                  placeholder="Name, e.g. Coffee"
                  aria-label="Watchlist name"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-sm"
                />
                <input
                  value={wlThreshold}
                  onChange={(e) => setWlThreshold(e.target.value)}
                  placeholder="$ limit"
                  aria-label="Monthly limit in dollars"
                  inputMode="decimal"
                  className="w-24 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-sm"
                />
              </div>
              <div className="flex gap-2">
                <input
                  value={wlTarget}
                  onChange={(e) => setWlTarget(e.target.value)}
                  placeholder={wlKind === "merchant" ? "Merchant, e.g. Blue Bottle" : "Category, e.g. Dining"}
                  aria-label="Merchant or category to watch"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-sm"
                />
                <div role="group" aria-label="Watch target type" className="flex shrink-0 rounded-lg bg-[var(--surface-secondary)] p-0.5">
                  {(["merchant", "category"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={wlKind === k}
                      onClick={() => setWlKind(k)}
                      className={`rounded-md px-2.5 py-1.5 text-[length:var(--type-micro-size)] font-semibold ${
                        wlKind === k ? "bg-[var(--surface-card)] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
                      }`}
                    >
                      {k === "merchant" ? "Merchant" : "Category"}
                    </button>
                  ))}
                </div>
              </div>
              {wlError && (
                <p className="text-[length:var(--type-caption-size)] text-[var(--signal-warning)]">{wlError}</p>
              )}
              <button
                type="submit"
                className="rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
              >
                Add watchlist
              </button>
            </form>
            {watchlists && watchlists.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {watchlists.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between gap-3 text-[length:var(--type-caption-size)]"
                  >
                    <span>
                      {w.name} · {w.target_kind === "merchant" ? w.target : `category ${w.target}`} ·{" "}
                      {formatUSD(w.threshold_cents)}/mo
                    </span>
                    <button
                      onClick={() => removeWatchlist(w.id)}
                      className="shrink-0 text-[length:var(--type-micro-size)] font-semibold text-[var(--text-micro)]"
                    >
                      Remove
                    </button>
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
