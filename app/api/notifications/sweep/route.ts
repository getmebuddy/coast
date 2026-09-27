import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createServiceSupabase } from "@/lib/supabase/server";
import { logPilotEvent } from "@/lib/analytics-server";
import {
  addDays,
  applyCaps,
  buildClickToken,
  buildUnsubscribeToken,
  chargeKey,
  digestKey,
  feeKey,
  foldUrgentIntoDigest,
  formatDollars,
  isNotificationEnabled,
  isSweepWindow,
  localWeekday,
  selectDigestSubject,
  startOfLocalDayUtc,
  todayKey,
  trialKey,
  type ComposedEmail,
  type EmailSection,
  type NotificationPrefs,
} from "@/lib/notifications";
import {
  APP_URL,
  buildNotificationEmail,
  sendEmail,
} from "@/lib/email-templates";
import {
  daysRemainingInclusive,
  effectiveCategory,
  localMonthStart,
  validTimezone,
  type Ledger,
  type LedgerTxn,
} from "@/lib/real-data";
import { isSpending } from "@/lib/ledger";
import { TOTAL_CATEGORY } from "@/lib/real-data-server";

/**
 * GET or POST /api/notifications/sweep — the morning notification sweep.
 *
 * NEVER user-callable: requires `Authorization: Bearer ${CRON_SECRET}`.
 * GET exists because Vercel Cron issues GET requests; POST for external
 * schedulers. NOTE: Vercel Cron cannot attach custom headers, so a
 * Vercel-cron invocation will 401 — the working scheduler is the GitHub
 * Actions workflow (.github/workflows/notification-sweep.yml), which
 * POSTs with the secret from repo secrets.
 * Intended cadence: every 15 min; each user is swept only inside their own
 * 06:45–07:00 local window.
 *
 * QUIET HOURS: the sweep-window gate IS the quiet-hours enforcement — no
 * email is ever composed or sent for a user outside their 06:45–07:00
 * local window. There is no other send path.
 *
 * Idempotency: a `sweep:<userId>:<date>` marker row (type 'sweep_marker')
 * is inserted at the start of each user's sweep; the
 * unique(user_id, dedupe_key) constraint makes a double sweep a no-op.
 * Every email also carries its own dedupe key, and 23505 on insert is
 * treated as "already sent, skip".
 *
 * Log-only until RESEND_API_KEY + NOTIFICATIONS_FROM exist: without them
 * sendEmail() returns skipped_no_provider and rows are logged as such.
 */

type Db = ReturnType<typeof createServiceSupabase>;

interface SweepFinding {
  id: string;
  routine_key: string;
  kind: string;
  title: string;
  detail: string;
  impact_cents: number;
  evidence: {
    merchant?: string;
    prev_amount_cents?: number;
    now_amount_cents?: number;
    transactions?: Array<{ id: string; merchant: string; amount_cents: number; date: string }>;
  } | null;
  status: string;
  snoozed_until: string | null;
  created_at: string;
  dedupe_hash: string;
}

const REASON_LINES: Record<string, string> = {
  attention_digest:
    "You're getting this because morning attention digests are on in your Coast notification settings.",
  charge_tomorrow:
    "You're getting this because charge-tomorrow alerts are on in your Coast notification settings.",
  fee_alert:
    "You're getting this because fee alerts are on in your Coast notification settings.",
  trial_converting:
    "You're getting this because trial alerts are on in your Coast notification settings.",
};

const INTROS: Record<string, string> = {
  attention_digest: "Here's what needs your attention this morning.",
  charge_tomorrow: "Heads up — this bills tomorrow.",
  fee_alert: "A fee showed up on your account.",
  trial_converting: "This trial is about to become a paid subscription.",
};

/** Mirror of listOpenFindings' filters, on the service client (no session in cron). */
async function loadOpenFindings(db: Db, userId: string): Promise<SweepFinding[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from("routine_findings")
    .select(
      "id, routine_key, kind, title, detail, impact_cents, evidence, status, snoozed_until, created_at, dedupe_hash"
    )
    .eq("user_id", userId)
    .or(`status.eq.open,and(status.eq.snoozed,snoozed_until.lte.${today})`)
    .order("impact_cents", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`sweep findings-read: ${error.message}`);
  return (data ?? []) as SweepFinding[];
}

function findingSection(f: SweepFinding): EmailSection {
  if (f.routine_key === "price_hike") {
    const nowCents = f.evidence?.now_amount_cents ?? Math.abs(f.impact_cents);
    const merchant = f.evidence?.merchant ?? f.title.replace(/ raised its price$/, "");
    return {
      type: "price_hike",
      leadKind: "price_hike",
      merchant,
      amountCents: nowCents,
      headline: `${merchant} raised its price to ${formatDollars(nowCents)}`,
      body: f.detail,
      ctaLabel: "Review subscription",
      ctaTarget: "/subscriptions",
    };
  }
  if (f.kind === "refund_received") {
    const txn = f.evidence?.transactions?.[0];
    const amt = txn ? Math.abs(txn.amount_cents) : Math.abs(f.impact_cents);
    const merchant = txn?.merchant;
    return {
      type: "refund_landed",
      leadKind: null,
      merchant,
      amountCents: amt,
      headline: `Refund landed: ${formatDollars(amt)}${merchant ? ` from ${merchant}` : ""}`,
      body: f.detail,
      ctaLabel: "View activity",
      ctaTarget: "/transactions",
    };
  }
  return {
    type: "attention_digest",
    leadKind: null,
    headline: f.title,
    body: f.detail,
    ctaLabel: "Open Morning Brief",
    ctaTarget: "/brief",
  };
}

/**
 * Budget-pace warnings. loadBudgetMonth() is session-bound (it reads through
 * the request's auth cookies), which don't exist in the cron context — so
 * the same spend-vs-limit computation runs here against the service client.
 * Rule (catalog): 80%+ of a category limit spent with a week or more left.
 */
async function budgetPaceSections(
  db: Db,
  userId: string,
  timezone: string,
  now: Date
): Promise<EmailSection[]> {
  const month = localMonthStart(now, timezone); // YYYY-MM-DD, first of month
  const daysLeft = daysRemainingInclusive(now, timezone);
  if (daysLeft < 7) return [];
  const { data: budgets, error: bErr } = await db
    .from("budgets")
    .select("category, limit_cents")
    .eq("user_id", userId)
    .eq("month", month);
  if (bErr) throw new Error(`sweep budget-read: ${bErr.message}`);
  const limits = (budgets ?? []).filter(
    (b) => b.category !== TOTAL_CATEGORY && b.limit_cents > 0
  );
  if (limits.length === 0) return [];

  const monthPrefix = month.slice(0, 7);
  const [y, m] = monthPrefix.split("-").map(Number);
  const nextMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
  const [txnsRes, overRes, rulesRes, splitsRes] = await Promise.all([
    db
      .from("transactions")
      .select("id, posted_at, merchant_normalized, amount_cents, kind, pending")
      .eq("user_id", userId)
      .gte("posted_at", `${monthPrefix}-01`)
      .lt("posted_at", `${nextMonth}-01`)
      .eq("pending", false)
      .lt("amount_cents", 0)
      .limit(5000),
    db.from("transaction_overrides").select("transaction_id, category").eq("user_id", userId),
    db.from("category_rules").select("match_pattern, category").eq("user_id", userId),
    db.from("splits").select("transaction_id, category, amount_cents").eq("user_id", userId),
  ]);
  if (txnsRes.error) throw new Error(`sweep ledger-read: ${txnsRes.error.message}`);
  const ledger: Ledger = {
    txns: (txnsRes.data ?? []) as LedgerTxn[],
    accountNames: new Map(),
    overrides: new Map((overRes.data ?? []).map((o) => [o.transaction_id, o.category])),
    rules: (rulesRes.data ?? []).map((r) => ({
      matchPattern: r.match_pattern,
      category: r.category,
    })),
    splits: new Map<string, Array<{ category: string; amount_cents: number }>>(),
  };
  for (const s of splitsRes.data ?? []) {
    const arr = ledger.splits.get(s.transaction_id) ?? [];
    arr.push({ category: s.category, amount_cents: s.amount_cents });
    ledger.splits.set(s.transaction_id, arr);
  }

  const spentByCat = new Map<string, number>();
  for (const t of ledger.txns) {
    if (!isSpending(t.kind)) continue;
    const eff = effectiveCategory(ledger, t);
    if (eff.removed) continue;
    if (eff.split) {
      for (const s of ledger.splits.get(t.id) ?? []) {
        spentByCat.set(s.category, (spentByCat.get(s.category) ?? 0) + s.amount_cents);
      }
      continue;
    }
    spentByCat.set(eff.category, (spentByCat.get(eff.category) ?? 0) + Math.abs(t.amount_cents));
  }

  const sections: EmailSection[] = [];
  for (const { category, limit_cents } of limits) {
    const spent = spentByCat.get(category) ?? 0;
    if (spent < 0.8 * limit_cents) continue;
    sections.push({
      type: "budget_pace",
      leadKind: null,
      merchant: category,
      amountCents: spent,
      headline: `${category}: ${formatDollars(spent)} of ${formatDollars(limit_cents)}`,
      body:
        spent >= limit_cents
          ? `You've spent ${formatDollars(spent)} on ${category} — that's over your ${formatDollars(limit_cents)} budget with ${daysLeft} days left in the month.`
          : `You've spent ${formatDollars(spent)} of your ${formatDollars(limit_cents)} ${category} budget with ${daysLeft} days left in the month.`,
      ctaLabel: "View budget",
      ctaTarget: "/budgets",
    });
  }
  return sections;
}

/** Friday recap section: this week's outflow total + purchase count. */
async function fridayRecapSection(
  db: Db,
  userId: string,
  timezone: string,
  now: Date
): Promise<EmailSection | null> {
  if (localWeekday(timezone, now) !== "Friday") return null;
  const dateKey = todayKey(timezone, now);
  const idx: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };
  const monday = addDays(dateKey, -(idx[localWeekday(timezone, now)] ?? 0));
  const { data, error } = await db
    .from("transactions")
    .select("amount_cents, kind")
    .eq("user_id", userId)
    .gte("posted_at", monday)
    .lte("posted_at", dateKey)
    .eq("pending", false)
    .lt("amount_cents", 0)
    .limit(2000);
  if (error) throw new Error(`sweep recap-read: ${error.message}`);
  const rows = (data ?? []).filter((t) => isSpending(t.kind));
  const total = rows.reduce((s, t) => s + Math.abs(t.amount_cents), 0);
  return {
    type: "friday_recap",
    leadKind: null,
    amountCents: total,
    headline: `Your week: ${formatDollars(total)} across ${rows.length} purchase${rows.length === 1 ? "" : "s"}`,
    body:
      `You spent ${formatDollars(total)} across ${rows.length} purchase${rows.length === 1 ? "" : "s"} this week. ` +
      `Have a good weekend — we'll be watching the numbers.`,
    ctaLabel: "Review your week",
    ctaTarget: "/spending",
  };
}

/** Best-effort account name for the fee copy ("your Chase account"). */
async function feeAccountLabel(
  db: Db,
  userId: string,
  f: SweepFinding
): Promise<string> {
  try {
    const txns = (f.evidence?.transactions ?? [])
      .slice()
      .sort((a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents));
    if (txns.length === 0) return "your account";
    const { data } = await db
      .from("transactions")
      .select("account_id")
      .eq("user_id", userId)
      .in(
        "id",
        txns.slice(0, 5).map((t) => t.id)
      );
    const accountId = (data ?? []).map((r) => r.account_id).find((a) => a != null);
    if (!accountId) return "your account";
    const { data: acct } = await db
      .from("accounts")
      .select("name")
      .eq("user_id", userId)
      .eq("id", accountId)
      .maybeSingle();
    return acct?.name ? `your ${acct.name} account` : "your account";
  } catch {
    return "your account";
  }
}

async function insertLogRow(
  db: Db,
  row: {
    id: string;
    user_id: string;
    type: string;
    channel: string;
    dedupe_key: string;
    subject: string;
    status: string;
  }
): Promise<"inserted" | "duplicate"> {
  const { error } = await db.from("notification_log").insert(row);
  if (error) {
    if (error.code === "23505") return "duplicate"; // already sent — skip
    throw new Error(`sweep log-write: ${error.message}`);
  }
  return "inserted";
}

async function sweepUser(
  db: Db,
  userId: string,
  rawTimezone: string,
  now: Date,
  cronSecret: string
): Promise<{ sent: number; deferred: number; skipped: string | null }> {
  const timezone = validTimezone(rawTimezone);
  const dateKey = todayKey(timezone, now);

  // Sweep marker first: the unique(user_id, dedupe_key) constraint makes a
  // second sweep for this user today a no-op, even if cron invocations overlap.
  const marker = await insertLogRow(db, {
    id: randomUUID(),
    user_id: userId,
    type: "sweep_marker",
    channel: "email",
    dedupe_key: `sweep:${userId}:${dateKey}`,
    subject: "sweep marker",
    status: "sent",
  });
  if (marker === "duplicate") return { sent: 0, deferred: 0, skipped: "already_swept" };

  const { data: prefRow } = await db
    .from("notification_prefs")
    .select("prefs, unsubscribed_all")
    .eq("user_id", userId)
    .maybeSingle();
  const prefs: NotificationPrefs | null = prefRow
    ? { prefs: (prefRow.prefs ?? {}) as Record<string, boolean>, unsubscribed_all: !!prefRow.unsubscribed_all }
    : null;
  if (prefs?.unsubscribed_all) return { sent: 0, deferred: 0, skipped: "unsubscribed" };

  const enabled = (type: string) => isNotificationEnabled(prefs, type);
  const tomorrowKey = addDays(dateKey, 1);

  // ---- gather ----
  const findings = await loadOpenFindings(db, userId);

  // last digest send (for refund recency); else 24h
  const { data: lastDigest } = await db
    .from("notification_log")
    .select("sent_at")
    .eq("user_id", userId)
    .eq("type", "attention_digest")
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const refundSince =
    lastDigest?.sent_at ?? new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  const { data: chargeRows } = await db
    .from("recurring")
    .select("id, merchant_normalized, last_amount_cents, amount_cents_avg, next_charge_date")
    .eq("user_id", userId)
    .eq("next_charge_date", tomorrowKey)
    .eq("dismissed", false)
    .neq("lifecycle_state", "ended");
  const charges = (chargeRows ?? [])
    .map((r) => ({
      id: r.id as string,
      merchant: r.merchant_normalized as string,
      amountCents: (r.last_amount_cents ?? r.amount_cents_avg ?? 0) as number,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);

  const { data: trialRows } = await db
    .from("recurring")
    .select("id, merchant_normalized, trial_ends_on")
    .eq("user_id", userId)
    .not("trial_ends_on", "is", null)
    .gte("trial_ends_on", dateKey)
    .lte("trial_ends_on", addDays(dateKey, 3))
    .eq("dismissed", false)
    .neq("lifecycle_state", "ended");
  const trials = (trialRows ?? []).map((r) => ({
    merchant: r.merchant_normalized as string,
    endsOn: r.trial_ends_on as string,
  }));

  // ---- digest sections ----
  const digestSections: EmailSection[] = [];
  const top3 = findings.filter((f) => f.routine_key !== "fee_sweep").slice(0, 3);
  const top3Ids = new Set(top3.map((f) => f.id));
  for (const f of top3) {
    const s = findingSection(f);
    if (enabled(s.type)) digestSections.push(s);
  }
  if (enabled("budget_pace")) {
    digestSections.push(...(await budgetPaceSections(db, userId, timezone, now)));
  }
  if (enabled("refund_landed")) {
    for (const f of findings) {
      if (f.kind !== "refund_received" || top3Ids.has(f.id)) continue;
      if (f.created_at < refundSince) continue;
      digestSections.push(findingSection(f));
    }
  }
  if (enabled("friday_recap")) {
    const recap = await fridayRecapSection(db, userId, timezone, now);
    if (recap) digestSections.push(recap);
  }

  let digest: ComposedEmail | null = null;
  if (digestSections.length > 0) {
    if (!enabled("attention_digest")) {
      // The digest would have sent but the user paused it — log the decision.
      await insertLogRow(db, {
        id: randomUUID(),
        user_id: userId,
        type: "attention_digest",
        channel: "email",
        dedupe_key: digestKey(userId, dateKey),
        subject: selectDigestSubject(digestSections).subject,
        status: "skipped_prefs",
      });
    } else {
      const onlyRecap = digestSections.every((s) => s.type === "friday_recap");
      digest = {
        type: "attention_digest",
        dedupeKey: digestKey(userId, dateKey),
        subject: onlyRecap
          ? "Your Friday money recap"
          : selectDigestSubject(digestSections).subject,
        sections: digestSections,
      };
    }
  }

  // ---- urgent items (each becomes a lead section, or a standalone email) ----
  const urgents: ComposedEmail[] = [];

  if (charges.length > 0 && enabled("charge_tomorrow")) {
    const lead = charges[0];
    const total = charges.reduce((s, c) => s + c.amountCents, 0);
    const section: EmailSection = {
      type: "charge_tomorrow",
      leadKind: "charge_tomorrow",
      merchant: lead.merchant,
      amountCents: lead.amountCents,
      headline: `${lead.merchant} bills ${formatDollars(lead.amountCents)} tomorrow`,
      body:
        charges.length === 1
          ? `${lead.merchant} charges ${formatDollars(lead.amountCents)} tomorrow. If you don't need it anymore, cancel before the charge posts.`
          : `${lead.merchant} charges ${formatDollars(lead.amountCents)} tomorrow, plus ${charges.length - 1} other subscription${charges.length - 1 === 1 ? "" : "s"} — ${formatDollars(total)} in total hitting tomorrow.`,
      ctaLabel: "Review subscriptions",
      ctaTarget: "/subscriptions",
    };
    urgents.push({
      type: "charge_tomorrow",
      dedupeKey: chargeKey(lead.id, tomorrowKey),
      subject: selectDigestSubject([section]).subject,
      sections: [section],
    });
  }

  const feeFinding = findings.find((f) => f.routine_key === "fee_sweep");
  if (feeFinding && enabled("fee_alert")) {
    const total = Math.abs(feeFinding.impact_cents);
    const accountLabel = await feeAccountLabel(db, userId, feeFinding);
    const section: EmailSection = {
      type: "fee_alert",
      leadKind: "fee",
      amountCents: total,
      accountLabel,
      headline: `A ${formatDollars(total)} fee hit ${accountLabel}`,
      body: feeFinding.detail,
      ctaLabel: "Open Morning Brief",
      ctaTarget: "/brief",
    };
    urgents.push({
      type: "fee_alert",
      dedupeKey: feeKey(feeFinding.dedupe_hash),
      subject: selectDigestSubject([section]).subject,
      sections: [section],
    });
  }

  if (enabled("trial_converting")) {
    for (const t of trials) {
      const daysLeft =
        Math.round(
          (new Date(`${t.endsOn}T12:00:00Z`).getTime() -
            new Date(`${dateKey}T12:00:00Z`).getTime()) /
            86_400_000
        );
      const when = daysLeft <= 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
      const headline = `${t.merchant} trial ends ${when}`;
      urgents.push({
        type: "trial_converting",
        dedupeKey: trialKey(t.merchant, t.endsOn),
        subject: headline,
        sections: [
          {
            type: "trial_converting",
            leadKind: null,
            merchant: t.merchant,
            headline,
            body: `Your ${t.merchant} trial ends ${t.endsOn} (${when}). Cancel before then if you don't want the paid plan to start.`,
            ctaLabel: "Review subscriptions",
            ctaTarget: "/subscriptions",
          },
        ],
      });
    }
  }

  // number_milestone (Phase 3): the type stays toggleable in the catalog, but
  // there is no progress-tracking query yet — intentionally not gathered.
  // unusual_spend (Phase 2): no detector routine exists yet — same.

  // ---- assemble, cap, send ----
  const pending: ComposedEmail[] = digest
    ? [foldUrgentIntoDigest(digest, urgents)]
    : urgents;

  const dayStart = startOfLocalDayUtc(timezone, now);
  const { count: sentToday } = await db
    .from("notification_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("sent_at", dayStart.toISOString())
    .eq("status", "sent")
    .neq("type", "sweep_marker");
  const { send, defer } = applyCaps(sentToday ?? 0, pending);

  for (const d of defer) {
    // Deferred, never dropped: the underlying signals (open findings,
    // recurring rows) persist and resurface in the next sweep's digest.
    await insertLogRow(db, {
      id: randomUUID(),
      user_id: userId,
      type: d.type,
      channel: "email",
      dedupe_key: d.dedupeKey,
      subject: d.subject,
      status: "skipped_cap",
    }).catch(() => {});
  }

  // Recipient address from the auth record (service-role only).
  const {
    data: { user },
  } = await db.auth.admin.getUserById(userId);
  const to = user?.email ?? null;
  if (!to) {
    console.warn(`[notifications] sweep: no email for user ${userId}, skipping sends`);
    return { sent: 0, deferred: defer.length, skipped: "no_email" };
  }

  let sent = 0;
  for (const em of send) {
    // The log id is minted BEFORE sending so click tokens can reference it.
    const logId = randomUUID();
    const sections = await Promise.all(
      em.sections.map(async (s) => ({
        headline: s.headline,
        body: s.body,
        ctaLabel: s.ctaLabel,
        ctaUrl: `${APP_URL}/api/notifications/click?token=${await buildClickToken(logId, s.ctaTarget, cronSecret)}`,
      }))
    );
    const primary = sections[0];
    const built = buildNotificationEmail({
      subject: em.subject,
      preheader: primary?.headline ?? em.subject,
      intro: INTROS[em.type] ?? INTROS.attention_digest,
      sections,
      primaryCta: { label: primary?.ctaLabel ?? "Open Coast", url: primary?.ctaUrl ?? APP_URL },
      reasonLine: REASON_LINES[em.type] ?? REASON_LINES.attention_digest,
    });

    let status: "sent" | "skipped_no_provider";
    // RFC 8058 one-click URL, minted per user (HMAC-bound, no session needed).
    const listUnsubscribeUrl = `${APP_URL}/api/notifications/unsubscribe?t=${await buildUnsubscribeToken(userId, cronSecret)}`;
    try {
      const result = await sendEmail({
        to,
        subject: built.subject,
        text: built.text,
        html: built.html,
        listUnsubscribeUrl,
      });
      status = result.status;
    } catch (e) {
      // Resend rejected it — log the error, skip this user, continue with
      // the rest. No log row: nothing was sent, so nothing is "already sent".
      console.error(`[notifications] send failed for ${userId} (${em.type})`, e);
      continue;
    }

    const written = await insertLogRow(db, {
      id: logId,
      user_id: userId,
      type: em.type,
      channel: "email",
      dedupe_key: em.dedupeKey,
      subject: em.subject,
      status,
    });
    if (written === "duplicate") continue; // already sent — skip
    if (status === "sent") {
      sent++;
      // Buckets/labels only — never money or PII.
      await logPilotEvent(userId, "notification_sent", { type: em.type, channel: "email" });
    }
  }

  return { sent, deferred: defer.length, skipped: null };
}

/**
 * The sweep entrypoint. Accepts GET (Vercel Cron issues GET) and POST
 * (external schedulers) — both require the bearer token. There is no
 * unauthenticated path: without CRON_SECRET configured the route fails
 * closed with 503.
 */
async function handleSweep(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createServiceSupabase();
  const now = new Date();

  // profiles.id IS the user id (references auth.users).
  const { data: profiles, error } = await db.from("profiles").select("id, timezone");
  if (error) {
    console.error("[notifications] sweep: profiles read failed", error);
    return NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }

  let swept = 0;
  let sent = 0;
  let deferred = 0;
  const skipped: Array<{ userId: string; reason: string }> = [];

  for (const p of profiles ?? []) {
    const timezone = validTimezone(p.timezone);
    // The sweep-window gate is the quiet-hours enforcement: no sends outside
    // the user's own 06:45–07:00 local window, ever.
    if (!isSweepWindow(timezone, now)) continue;
    try {
      const r = await sweepUser(db, p.id as string, timezone, now, cronSecret);
      swept++;
      sent += r.sent;
      deferred += r.deferred;
      if (r.skipped) skipped.push({ userId: p.id as string, reason: r.skipped });
    } catch (e) {
      console.error(`[notifications] sweep failed for user ${p.id}`, e);
      skipped.push({ userId: p.id as string, reason: "error" });
    }
  }

  return NextResponse.json({ ok: true, swept, sent, deferred, skipped });
}

export async function POST(req: Request) {
  return handleSweep(req);
}

export async function GET(req: Request) {
  return handleSweep(req);
}
