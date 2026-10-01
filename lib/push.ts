/**
 * Web-push notifications — payload composition, subscription validation,
 * and delivery with expired-subscription cleanup.
 *
 * Server-only (imports web-push, a node library). The settings page does
 * its own PushManager work client-side and never imports this module.
 *
 * Push is for URGENT types only — the standalone "worth interrupting"
 * kinds: charge_tomorrow, price_hike, fee_alert, trial_converting — plus the
 * monthly spending report's teaser, the one digest exception (it points at
 * the in-app report, not the email, and fires at most once a month).
 * Everything else stays email-only (spec: send only notifications genuinely
 * worth opening; pushes interrupt, so the bar is higher).
 *
 * Copy follows the approved phone designs: title = the money or the
 * count, body = one plain-English line under ~110 chars, deep link to the
 * exact finding. Push failures never break the email path — the sweep
 * calls deliverPush inside its own try/catch and continues.
 */

import webpush from "web-push";
import type { createServiceSupabase } from "@/lib/supabase/server";

type Db = ReturnType<typeof createServiceSupabase>;

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** App-relative deep link, e.g. "/subscriptions". */
  url: string;
  /** Stable tag so a re-sent alert replaces, never stacks. */
  tag: string;
}

/** Max lengths enforced before sending (service worker truncates too). */
export const PUSH_TITLE_MAX = 80;
export const PUSH_BODY_MAX = 110;

/** Types allowed to interrupt via push. Everything else is email-only. */
export const PUSHABLE_TYPES = new Set([
  "charge_tomorrow",
  "price_hike",
  "fee_alert",
  "trial_converting",
  "monthly_spending_report",
]);

export function isPushableType(typeId: string): boolean {
  return PUSHABLE_TYPES.has(typeId);
}

/** Collapse whitespace; truncate at a word boundary with an ellipsis. */
export function truncateAtWord(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1); // room for the ellipsis
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return head.trimEnd() + "…";
}

/** App-relative paths only — never an absolute URL (open-redirect guard). */
export function safePushUrl(u: string): string {
  if (u.startsWith("//")) return "/brief"; // protocol-relative URL
  if (/^\/[^\s\\]*$/.test(u) && !u.includes("://") && !u.includes("..")) return u;
  return "/brief";
}

/** Enforce title/body length limits and URL safety. Pure — unit tested. */
export function composePushPayload(input: {
  title: string;
  body: string;
  url: string;
  tag: string;
}): PushPayload {
  return {
    title: truncateAtWord(input.title || "Coast", PUSH_TITLE_MAX),
    body: truncateAtWord(input.body || "", PUSH_BODY_MAX),
    url: safePushUrl(input.url),
    tag: (input.tag || "coast").slice(0, 64),
  };
}

/** True when the server can actually send pushes (keys configured). */
export function vapidConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  );
}

// ---------------------------------------------------------------------------
// Subscription validation (used by the subscribe API route). Pure.
// ---------------------------------------------------------------------------

export interface ValidSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function validatePushSubscription(
  body: unknown
): { ok: true; sub: ValidSubscription } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  const { endpoint, keys } = b;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return { ok: false, error: "endpoint must be an https URL" };
  }
  if (endpoint.length > 2000) {
    return { ok: false, error: "endpoint too long" };
  }
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    return { ok: false, error: "keys must be an object with p256dh and auth" };
  }
  const k = keys as Record<string, unknown>;
  if (typeof k.p256dh !== "string" || k.p256dh.length === 0) {
    return { ok: false, error: "keys.p256dh must be a non-empty string" };
  }
  if (typeof k.auth !== "string" || k.auth.length === 0) {
    return { ok: false, error: "keys.auth must be a non-empty string" };
  }
  return {
    ok: true,
    sub: { endpoint, p256dh: k.p256dh, auth: k.auth },
  };
}

// ---------------------------------------------------------------------------
// Delivery. Expired subscriptions (404/410 from the push service) are
// deleted; anything else is logged and left alone. Never throws.
// ---------------------------------------------------------------------------

export type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string
) => Promise<unknown>;

const defaultSender: PushSender = (sub, payload) =>
  webpush.sendNotification(sub, payload);

export interface PushDeliveryResult {
  sent: number;
  expired: number;
  failed: number;
  skipped: string | null;
}

function isExpiredError(e: unknown): boolean {
  const code = (e as { statusCode?: unknown } | null)?.statusCode;
  return code === 404 || code === 410;
}

export async function deliverPush(
  db: Db,
  userId: string,
  payload: PushPayload,
  sender: PushSender = defaultSender
): Promise<PushDeliveryResult> {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    return { sent: 0, expired: 0, failed: 0, skipped: "not_configured" };
  }
  const contact = process.env.VAPID_CONTACT_EMAIL || "notifications@coast.app";
  try {
    webpush.setVapidDetails(`mailto:${contact}`, publicKey, privateKey);
  } catch (e) {
    console.warn("[push] bad VAPID config", e);
    return { sent: 0, expired: 0, failed: 0, skipped: "bad_config" };
  }

  const { data, error } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);
  if (error) {
    console.warn("[push] subscription read failed", error.message);
    return { sent: 0, expired: 0, failed: 0, skipped: "db_read" };
  }
  const subs = (data ?? []) as PushSubscriptionRow[];
  if (subs.length === 0) {
    return { sent: 0, expired: 0, failed: 0, skipped: "no_subscriptions" };
  }

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag,
  });

  let sent = 0;
  let expired = 0;
  let failed = 0;
  for (const sub of subs) {
    try {
      await sender(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
      sent++;
    } catch (e) {
      if (isExpiredError(e)) {
        expired++;
        const { error: delErr } = await db
          .from("push_subscriptions")
          .delete()
          .eq("id", sub.id);
        if (delErr) {
          console.warn("[push] expired-subscription delete failed", delErr.message);
        }
      } else {
        failed++;
        console.warn("[push] send failed", (e as Error)?.message ?? e);
      }
    }
  }
  return { sent, expired, failed, skipped: null };
}
