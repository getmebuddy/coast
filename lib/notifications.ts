/**
 * Notification system — type catalog (spec v1 §2).
 *
 * Single source of truth for the 10 notification types. Server sweep logic,
 * the settings UI, and tests all import this. Phase 2/3 types are toggleable
 * now; they fire when their phase ships (spec: "mark honestly").
 *
 * Conventions: money = integer cents, dates = YYYY-MM-DD, copy is calm
 * plain English. Notify-only — nothing here moves money or contacts anyone.
 */

import { validTimezone } from "./real-data";
import { finishLineLine, netIncomeLine, type MonthSummary } from "./spending";

export type NotificationClass = "digest" | "urgent";
export type NotificationPhase = 1 | 2 | 3;

export interface NotificationType {
  /** Stable id. Used in notification_prefs.prefs keys, notification_log.type, and email ?notif= params. */
  id: string;
  name: string;
  /** Plain-English description for the settings UI. */
  description: string;
  phase: NotificationPhase;
  class: NotificationClass;
  defaultOn: boolean;
}

export const NOTIFICATION_TYPES: NotificationType[] = [
  {
    id: "attention_digest",
    name: "Morning attention digest",
    description: "A morning roundup when anything needs your attention. Quiet mornings stay silent.",
    phase: 1,
    class: "digest",
    defaultOn: true,
  },
  {
    id: "charge_tomorrow",
    name: "Charge tomorrow",
    description: "A heads-up the day before a subscription bills you.",
    phase: 1,
    class: "urgent",
    defaultOn: true,
  },
  {
    id: "price_hike",
    name: "Price-hike alerts",
    description: "When a subscription raises its price.",
    phase: 1,
    class: "digest",
    defaultOn: true,
  },
  {
    id: "budget_pace",
    name: "Budget pace warnings",
    description: "When a budget category is running hot — 80%+ spent with a week or more left.",
    phase: 1,
    class: "digest",
    defaultOn: true,
  },
  {
    id: "fee_alert",
    name: "Fee alerts",
    description: "When a bank, late, or foreign-transaction fee hits your account.",
    phase: 1,
    class: "urgent",
    defaultOn: true,
  },
  {
    id: "refund_landed",
    name: "Refund landed",
    description: "When money you were owed actually arrives.",
    phase: 1,
    class: "digest",
    defaultOn: true,
  },
  {
    id: "friday_recap",
    name: "Friday recap",
    description: "A short Friday summary of your week in money.",
    phase: 1,
    class: "digest",
    defaultOn: true,
  },
  {
    id: "monthly_spending_report",
    name: "Monthly spending report",
    description: "A monthly report of your income, spending, and finish-line pace.",
    phase: 1,
    class: "digest",
    defaultOn: true,
  },
  {
    id: "unusual_spend",
    name: "Unusual spend",
    description: "When a category's weekly spend looks out of character.",
    phase: 2,
    class: "digest",
    defaultOn: true,
  },
  {
    id: "trial_converting",
    name: "Trial converting soon",
    description: "A few days before a trial becomes a paid subscription.",
    phase: 2,
    class: "urgent",
    defaultOn: true,
  },
  {
    id: "number_milestone",
    name: "Number milestones",
    description: "When you cross a milestone toward your Number (25, 50, 75, 90, 100%).",
    phase: 3,
    class: "digest",
    defaultOn: true,
  },
];

export const NOTIFICATION_TYPE_IDS = new Set(NOTIFICATION_TYPES.map((t) => t.id));

/** Prefs shape stored in notification_prefs.prefs: { "<type>": false }; absent = default ON. */
export interface NotificationPrefs {
  prefs: Record<string, boolean>;
  unsubscribed_all: boolean;
}

/**
 * Whether a type may send for a user. Absent key = default ON (per spec §6);
 * explicit false opts out; unsubscribed_all silences everything.
 */
export function isNotificationEnabled(
  prefs: NotificationPrefs | null | undefined,
  typeId: string
): boolean {
  if (!prefs) return true;
  if (prefs.unsubscribed_all) return false;
  const v = prefs.prefs[typeId];
  if (v === false) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Sweep scheduling helpers (pure, timezone-aware)
// ---------------------------------------------------------------------------

/**
 * True when the user's local time is inside the morning sweep window
 * [06:45, 07:00). Invalid timezones are treated as "not in window".
 */
export function isSweepWindow(timezone: string, now: Date): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
    const totalMinutes = hour * 60 + minute;
    return totalMinutes >= 6 * 60 + 45 && totalMinutes < 7 * 60;
  } catch {
    return false;
  }
}

/** Local calendar date (YYYY-MM-DD) in the user's timezone — the dedupe-day. */
export function todayKey(timezone: string, now: Date): string {
  const tz = validTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** True when the user's local date is the 1st of the month. */
export function isFirstOfMonth(timezone: string, now: Date): boolean {
  return todayKey(timezone, now).endsWith("-01");
}

/**
 * YYYY-MM of the just-ended month in the user's timezone — the month the
 * monthly spending report covers. Pure.
 */
export function previousMonthKey(timezone: string, now: Date): string {
  const [y, m] = todayKey(timezone, now).split("-").map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/**
 * UTC instant of local midnight for the user's current calendar day.
 * Used to count "emails sent today" in the user's own day, DST-safe.
 */
export function startOfLocalDayUtc(timezone: string, now: Date): Date {
  const tz = validTimezone(timezone);
  const date = todayKey(tz, now);
  const guess = new Date(`${date}T00:00:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = asUtc - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

/** Local weekday name ("Monday".."Sunday") in the user's timezone. */
export function localWeekday(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: validTimezone(timezone),
    weekday: "long",
  }).format(now);
}

/** ISO week key ("2026-W39") for the user's local date — Friday-recap dedupe. */
export function isoWeekKey(timezone: string, now: Date): string {
  const d = new Date(`${todayKey(timezone, now)}T12:00:00.000Z`);
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to Thursday
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Add (or subtract) whole days to a YYYY-MM-DD key. */
export function addDays(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Whole dollars drop the cents, matching the copy deck
 * ("A $35 fee…", "Netflix bills $15.49 tomorrow").
 */
export function formatDollars(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${sign}$${dollars}` : `${sign}$${dollars}.${String(rem).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Email composition (pure)
// ---------------------------------------------------------------------------

/** The lead kinds that can win the digest subject line, in priority order. */
export type DigestLeadKind = "charge_tomorrow" | "fee" | "price_hike";

/** Email row emphasis: green for money back, warm red for costs, ink for neutral. */
export type EmailTone = "positive" | "negative" | "neutral";

export interface EmailStat {
  value: string;
  label: string;
  tone?: EmailTone;
}

export interface EmailSection {
  /** Notification type id this section belongs to (for prefs gating). */
  type: string;
  /** Non-null when this section can lead the digest subject. */
  leadKind: DigestLeadKind | null;
  merchant?: string;
  /** Charge amount, fee total, or new price — the number up front. */
  amountCents?: number;
  /** Fee copy only: "your Chase account"; defaults to "your account". */
  accountLabel?: string;
  /** Right-side email stat override; defaults to the formatted amountCents. */
  stat?: string;
  tone?: EmailTone;
  /** Optional stat strip rendered above this section's email card. */
  stats?: EmailStat[];
  headline: string;
  body: string;
  ctaLabel: string;
  /** App-relative path, e.g. "/brief" — wrapped in a click token at send time. */
  ctaTarget: string;
}

export interface ComposedEmail {
  /** Primary notification type id (notification_log.type + pilot event). */
  type: string;
  dedupeKey: string;
  subject: string;
  sections: EmailSection[];
}

function maxBy<T>(items: T[], f: (t: T) => number): T | undefined {
  let best: T | undefined;
  let bestV = -Infinity;
  for (const it of items) {
    const v = f(it);
    if (v > bestV) {
      bestV = v;
      best = it;
    }
  }
  return best;
}

/**
 * Digest subject, per spec §3: the single most important item wins.
 * charge-tomorrow > fee > price-hike > findings count.
 */
export function selectDigestSubject(sections: EmailSection[]): {
  subject: string;
  leadType: string;
} {
  const charge = maxBy(
    sections.filter((s) => s.leadKind === "charge_tomorrow" && s.merchant && s.amountCents != null),
    (s) => s.amountCents ?? 0
  );
  if (charge) {
    return {
      subject: `${charge.merchant} bills ${formatDollars(charge.amountCents ?? 0)} tomorrow`,
      leadType: "charge_tomorrow",
    };
  }
  const fee = maxBy(
    sections.filter((s) => s.leadKind === "fee"),
    (s) => s.amountCents ?? 0
  );
  if (fee) {
    return {
      subject: `A ${formatDollars(fee.amountCents ?? 0)} fee hit ${fee.accountLabel ?? "your account"}`,
      leadType: "fee_alert",
    };
  }
  const hike = maxBy(
    sections.filter((s) => s.leadKind === "price_hike" && s.merchant && s.amountCents != null),
    (s) => s.amountCents ?? 0
  );
  if (hike) {
    return {
      subject: `${hike.merchant} raised its price to ${formatDollars(hike.amountCents ?? 0)}`,
      leadType: "price_hike",
    };
  }
  const n = sections.length;
  return {
    subject: n === 1 ? "1 thing needs your attention" : `${n} things need your attention`,
    leadType: "attention_digest",
  };
}

/** Max emails per user per day. The digest counts as one. */
export const MAX_EMAILS_PER_DAY = 2;

/**
 * Enforce the daily cap. `pending` must already be ordered most-important
 * first (digest first, then standalone urgents). Deferred items are NOT
 * dropped — the caller logs them as skipped_cap and their underlying
 * signals (open findings, recurring rows) resurface in the next sweep.
 */
export function applyCaps(
  sentTodayCount: number,
  pending: ComposedEmail[]
): { send: ComposedEmail[]; defer: ComposedEmail[] } {
  const sent = Number.isFinite(sentTodayCount) ? Math.max(0, Math.floor(sentTodayCount)) : 0;
  const remaining = Math.max(0, MAX_EMAILS_PER_DAY - sent);
  return { send: pending.slice(0, remaining), defer: pending.slice(remaining) };
}

/**
 * Urgent items become the digest's lead sections; the result is ONE email.
 * The subject is re-selected because a folded-in urgent can outrank the
 * digest's own lead (charge-tomorrow beats everything).
 */
export function foldUrgentIntoDigest(
  digest: ComposedEmail,
  urgents: ComposedEmail[]
): ComposedEmail {
  const sections = [...urgents.flatMap((u) => u.sections), ...digest.sections];
  const { subject } = selectDigestSubject(sections);
  return { ...digest, subject, sections };
}

// ---------------------------------------------------------------------------
// Dedupe keys — the unique(user_id, dedupe_key) idempotency contract.
// ---------------------------------------------------------------------------

/** One digest per user per day. */
export const digestKey = (userId: string, date: string): string => `digest:${userId}:${date}`;
/** One charge alert per recurring row per charge date. */
export const chargeKey = (recurringId: string, date: string): string =>
  `charge:${recurringId}:${date}`;
/** Fee findings carry a monthly dedupe hash — at most one fee alert a month. */
export const feeKey = (findingDedupeHash: string): string => `fee:${findingDedupeHash}`;
/** One alert per trial end date. */
export const trialKey = (merchant: string, trialEndsOn: string): string =>
  `trial:${merchant}:${trialEndsOn}`;
/** One Friday recap per ISO week. */
export const recapKey = (userId: string, isoWeek: string): string => `recap:${userId}:${isoWeek}`;
/** One monthly spending report per calendar month. */
export const spendingReportKey = (userId: string, monthKey: string): string =>
  `spending_report:${userId}:${monthKey}`;
/** One milestone email per progress band (Phase 3 — defined, not yet sent). */
export const milestoneKey = (userId: string, band: string): string =>
  `milestone:${userId}:${band}`;
/** One alert per refund finding. */
export const refundKey = (findingDedupeHash: string): string => `refund:${findingDedupeHash}`;
/** One alert per unusual-spend finding (Phase 2 — defined, not yet sent). */
export const anomalyKey = (findingDedupeHash: string): string => `anomaly:${findingDedupeHash}`;
/** One budget-pace alert per category per month. */
export const budgetKey = (category: string, month: string): string =>
  `budget:${category}:${month}`;
/** One alert per price-hike finding. */
export const hikeKey = (findingDedupeHash: string): string => `hike:${findingDedupeHash}`;

// ---------------------------------------------------------------------------
// In-app deep links.
//
// Single map from notification type -> the exact surface the row opens.
// Used by the notification center (bell) and the /notifications archive so a
// tap lands on the finding, never the homepage. Unknown types fall back to
// /brief, the surface that always exists for signed-in users.
export function notificationDeepLink(type: string): string {
  switch (type) {
    case "attention_digest":
      return "/brief";
    case "charge_tomorrow":
      return "/subscriptions";
    case "price_hike":
      return "/subscriptions";
    case "budget_pace":
      return "/spending";
    case "fee_alert":
      return "/transactions";
    case "refund_landed":
      return "/transactions";
    case "friday_recap":
      return "/brief";
    case "monthly_spending_report":
      return "/spending";
    case "unusual_spend":
      return "/spending";
    case "trial_converting":
      return "/subscriptions";
    case "number_milestone":
      return "/number";
    default:
      return "/brief";
  }
}

/** Raw notification_log row as read by the notification center. */
export interface NotificationLogRow {
  id: string;
  type: string;
  subject: string;
  channel: string;
  sent_at: string;
  read_at: string | null;
}

/** notification_log row enriched for the in-app notification center. */
export interface NotificationCenterItem extends NotificationLogRow {
  typeName: string;
  href: string;
  unread: boolean;
}

/**
 * Enrich a notification_log row for display: human type name, exact deep
 * link, and unread flag (read_at NULL = unread). Pure — unit-tested.
 */
export function toNotificationCenterItem(row: NotificationLogRow): NotificationCenterItem {
  const typeName =
    NOTIFICATION_TYPES.find((t) => t.id === row.type)?.name ?? row.type;
  return {
    ...row,
    typeName,
    href: notificationDeepLink(row.type),
    unread: row.read_at == null,
  };
}

// ---------------------------------------------------------------------------
// Click-tracking tokens.
//
// token = base64url(`${logId}|${targetPath}|${hmac}`),
// hmac = HMAC-SHA256(`${logId}|${targetPath}`, CRON_SECRET).
//
// Implemented on Web Crypto (async) so this module stays universal — the
// settings UI imports the catalog from here and must keep bundling for the
// browser. No node:crypto import.
// ---------------------------------------------------------------------------

function base64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** App-relative paths only — never an absolute URL (open-redirect guard). */
function isSafeTargetPath(p: string): boolean {
  if (p.startsWith("//")) return false; // protocol-relative URL
  return /^\/[^\s\\]*$/.test(p) && !p.includes("://") && !p.includes("..");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build a signed click token for a notification_log row id + target path. */
export async function buildClickToken(
  logId: string,
  targetPath: string,
  secret: string
): Promise<string> {
  if (!UUID_RE.test(logId)) throw new Error("click-token: bad log id");
  if (!isSafeTargetPath(targetPath)) throw new Error("click-token: unsafe target path");
  const payload = `${logId}|${targetPath}`;
  const hmac = await hmacHex(secret, payload);
  return base64urlEncode(`${payload}|${hmac}`);
}

/**
 * Verify a click token. Returns the log id + target path, or null when the
 * token is malformed, tampered, signed with another secret, or points
 * somewhere unsafe.
 */
export async function verifyClickToken(
  token: string,
  secret: string
): Promise<{ logId: string; targetPath: string } | null> {
  let decoded: string;
  try {
    decoded = base64urlDecode(token);
  } catch {
    return null;
  }
  const parts = decoded.split("|");
  if (parts.length < 3) return null;
  const hmac = parts[parts.length - 1];
  const logId = parts[0];
  const targetPath = parts.slice(1, -1).join("|");
  if (!UUID_RE.test(logId) || !isSafeTargetPath(targetPath)) return null;
  if (!/^[0-9a-f]{64}$/.test(hmac)) return null;
  const expected = await hmacHex(secret, `${logId}|${targetPath}`);
  if (expected.length !== hmac.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ hmac.charCodeAt(i);
  }
  if (diff !== 0) return null;
  return { logId, targetPath };
}

const UUID_RE_UNSUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One-click unsubscribe token (RFC 8058). Binds a user id with an HMAC so
 * the List-Unsubscribe-Post endpoint can unsubscribe without a session.
 * The token IS the auth — treat it like a password (never logged).
 */
export async function buildUnsubscribeToken(
  userId: string,
  secret: string
): Promise<string> {
  if (!UUID_RE_UNSUB.test(userId)) throw new Error("unsubscribe-token: <redacted>");
  const payload = `unsub:${userId}`;
  const hmac = await hmacHex(secret, payload);
  return base64urlEncode(`${payload}|${hmac}`);
}

/** Verify an unsubscribe token. Returns the user id, or null. */
export async function verifyUnsubscribeToken(
  token: string,
  secret: string
): Promise<string | null> {
  let decoded: string;
  try {
    decoded = base64urlDecode(token);
  } catch {
    return null;
  }
  const idx = decoded.lastIndexOf("|");
  if (idx < 0) return null;
  const payload = decoded.slice(0, idx);
  const hmac = decoded.slice(idx + 1);
  if (!/^unsub:[0-9a-f-]{36}$/i.test(payload)) return null;
  if (!/^[0-9a-f]{64}$/.test(hmac)) return null;
  const expected = await hmacHex(secret, payload);
  if (expected.length !== hmac.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ hmac.charCodeAt(i);
  }
  if (diff !== 0) return null;
  return payload.slice("unsub:".length);
}

// ---------------------------------------------------------------------------
// Monthly spending report (pure composition)
// ---------------------------------------------------------------------------

/** Subject for the monthly spending report email. Pure. */
export function monthlyReportSubject(summary: MonthSummary): string {
  return `Your ${summary.monthLabel} spending report`;
}

/**
 * The monthly spending report as email sections. The lead section carries
 * the stat strip (Income | Total spend | Net); every section shares one
 * card heading so they render as a single card with one primary CTA.
 * Pure — the sweep supplies the summary and the FIRE pace.
 */
export function monthlyReportSections(
  summary: MonthSummary,
  finishLineMonthlyCents: number | null
): EmailSection[] {
  const comparison =
    netIncomeLine(summary.incomeCents, summary.spendCents) ??
    `No income landed in ${summary.monthLabel} — spending only.`;
  const cta = { ctaLabel: "See your spending", ctaTarget: "/spending" };
  const sections: EmailSection[] = [
    {
      type: "monthly_spending_report",
      leadKind: null,
      amountCents: summary.netCents,
      stat: formatDollars(summary.netCents),
      tone: summary.netCents < 0 ? "negative" : "positive",
      stats: [
        { value: formatDollars(summary.incomeCents), label: "income" },
        { value: formatDollars(summary.spendCents), label: "spent" },
        {
          value: formatDollars(summary.netCents),
          label: "net",
          tone: summary.netCents < 0 ? "negative" : "positive",
        },
      ],
      headline: "Net income",
      body: comparison,
      ...cta,
    },
  ];
  if (finishLineMonthlyCents != null) {
    const delta = summary.spendCents - finishLineMonthlyCents;
    sections.push({
      type: "monthly_spending_report",
      leadKind: null,
      tone: delta > 0 ? "negative" : "positive",
      stat:
        delta === 0
          ? "on pace"
          : `${formatDollars(Math.abs(delta))} ${delta > 0 ? "over" : "under"}`,
      headline: "Finish-line pace",
      body: finishLineLine(summary.spendCents, finishLineMonthlyCents),
      ...cta,
    });
  }
  for (const c of summary.categories.slice(0, 5)) {
    sections.push({
      type: "monthly_spending_report",
      leadKind: null,
      merchant: c.category,
      amountCents: c.spendCents,
      tone: "neutral",
      headline: c.category,
      body: `${c.txnCount} transaction${c.txnCount === 1 ? "" : "s"} in ${summary.monthLabel}`,
      ...cta,
    });
  }
  if (summary.biggestTxn) {
    const b = summary.biggestTxn;
    sections.push({
      type: "monthly_spending_report",
      leadKind: null,
      merchant: b.merchant,
      amountCents: b.amountCents,
      tone: "neutral",
      headline: b.merchant,
      body: `Your biggest single purchase in ${summary.monthLabel} (${b.date}).`,
      ...cta,
    });
  }
  return sections;
}

/** Push teaser copy for the monthly report. Pure. */
export function monthlyReportPush(summary: MonthSummary): { title: string; body: string } {
  return {
    title: `Your ${summary.monthLabel} report is ready`,
    body: `You spent ${formatDollars(summary.spendCents)} in ${summary.monthLabel} — see where it went.`,
  };
}
