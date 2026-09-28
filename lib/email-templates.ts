/**
 * Notification email templates + Resend transport.
 *
 * SERVER ONLY in practice (the sweep route imports this). Templates follow
 * the approved v2 design: green brand band with the finish-line illustration,
 * count-first headline, personalized subhead, section cards with letter-avatar
 * rows (one number per row, right-aligned), an optional stat strip, exactly
 * one pill CTA (the lead card's) with text links for the rest, and a footer
 * naming the exact toggle that triggered the send.
 *
 * Copy deck: calm plain English, the number up front, no engagement bait.
 *
 * LOG-ONLY MODE: sendEmail() returns { status: "skipped_no_provider" } until
 * both RESEND_API_KEY and NOTIFICATIONS_FROM are set. No email ever leaves
 * the building without them.
 *
 * CAN-SPAM: every footer carries a physical mailing address. It reads from
 * NOTIFICATIONS_MAILING_ADDRESS — real sends MUST NOT go out while the
 * placeholder below is still in place. Set the env var when the entity
 * decision lands.
 */

import type { EmailStat, EmailTone } from "./notifications";

export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://coast-whitemattertechnologies-3980.vercel.app";

export const SETTINGS_URL = `${APP_URL}/settings/notifications`;

/** Absolute URL — email clients can't resolve relative paths. */
export const HEADER_IMAGE_URL = `${APP_URL}/email/header.png`;

/**
 * One-click List-Unsubscribe target (RFC 8058). This is a URL *template* —
 * the sweep mints a per-user signed token and passes the full URL into
 * sendEmail() as listUnsubscribeUrl. Humans clicking "Unsubscribe" in the
 * footer land on SETTINGS_URL instead.
 */

/**
 * Physical mailing address for the CAN-SPAM footer. Placeholder until the
 * entity decision — do not send real mail with this unresolved.
 */
export const MAILING_ADDRESS =
  process.env.NOTIFICATIONS_MAILING_ADDRESS ??
  "[mailing address pending — set NOTIFICATIONS_MAILING_ADDRESS before real sends]";

export interface TemplateRow {
  title: string;
  body: string;
  /** Right-side bold number, e.g. "$15.49". Empty string hides the stat. */
  stat: string;
  tone: EmailTone;
  /** Seed for the deterministic letter avatar (merchant name or title). */
  iconSeed: string;
}

export interface TemplateSection {
  /** Notification type id — drives card grouping and the card heading. */
  type: string;
  rows: TemplateRow[];
  /** Optional stat strip rendered as its own block above this section's card. */
  stats?: EmailStat[];
  ctaLabel: string;
  /** Fully-qualified click-tracking URL (built by the sweep route). */
  ctaUrl: string;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Pastel letter-avatar palette (soft bg, saturated letter), approved in v2. */
const AVATAR_COLORS: Array<readonly [string, string]> = [
  ["#e8f0ea", "#2f6f4e"], // green
  ["#fdf3e3", "#b3541e"], // amber
  ["#f3e8e8", "#a33b3b"], // red
  ["#eef2f7", "#3b5a80"], // blue
  ["#f0eaf4", "#7d5a8f"], // violet
  ["#e6f2f0", "#2e7d74"], // teal
];

const TONE_COLORS: Record<EmailTone, string> = {
  positive: "#2f6f4e",
  negative: "#b3541e",
  neutral: "#1c1a15",
};

/** Deterministic avatar pick (djb2), mirroring lib/merchant-avatar.ts. */
function avatarFor(seed: string): { letter: string; bg: string; fg: string } {
  const m = (seed ?? "").match(/[A-Za-z0-9]/);
  const letter = m ? m[0].toUpperCase() : "?";
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  const [bg, fg] = AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  return { letter, bg, fg };
}

/**
 * Card grouping: sections whose types share a card merge into one card,
 * in first-appearance order. This is what puts the price hike and the
 * watchlist breach in the same "Needs your attention" card.
 */
const CARD_DEFS: Record<string, { heading: string; subhead: string }> = {
  price_hike: { heading: "Needs your attention", subhead: "Findings from your Morning Brief." },
  attention_digest: { heading: "Needs your attention", subhead: "Findings from your Morning Brief." },
  budget_pace: { heading: "Budget pace", subhead: "Categories getting close to their limits." },
  charge_tomorrow: { heading: "Charging tomorrow", subhead: "Recurring charges landing tomorrow." },
  fee_alert: { heading: "Fees", subhead: "Worth a second look." },
  refund_landed: { heading: "Refunds", subhead: "Money back in your account." },
  trial_converting: { heading: "Trials ending soon", subhead: "Decide before they convert." },
  friday_recap: { heading: "Your week", subhead: "A quick look back." },
};

function cardFor(type: string): { heading: string; subhead: string } {
  return CARD_DEFS[type] ?? { heading: "Updates", subhead: "From your Coast account." };
}

interface Card {
  heading: string;
  subhead: string;
  rows: TemplateRow[];
  stats: EmailStat[];
  ctaLabel: string;
  ctaUrl: string;
}

function groupIntoCards(sections: TemplateSection[]): Card[] {
  const cards: Card[] = [];
  const byHeading = new Map<string, Card>();
  for (const s of sections) {
    const { heading, subhead } = cardFor(s.type);
    let card = byHeading.get(heading);
    if (!card) {
      card = { heading, subhead, rows: [], stats: [], ctaLabel: s.ctaLabel, ctaUrl: s.ctaUrl };
      byHeading.set(heading, card);
      cards.push(card);
    }
    card.rows.push(...s.rows);
    if (s.stats) card.stats.push(...s.stats);
  }
  return cards;
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";

function rowHtml(r: TemplateRow): string {
  const { letter, bg, fg } = avatarFor(r.iconSeed);
  const statCell = r.stat
    ? `<td valign="top" align="right" style="white-space:nowrap;padding-left:8px;"><p style="margin:0;font-size:16px;font-weight:700;color:${TONE_COLORS[r.tone]};${FONT}">${escapeHtml(r.stat)}</p></td>`
    : "";
  return `
    <tr><td style="padding:16px 0;border-top:1px solid #ece8dd;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="48" valign="top"><div style="width:44px;height:44px;border-radius:50%;background-color:${bg};color:${fg};font-size:18px;font-weight:700;line-height:44px;text-align:center;${FONT}">${escapeHtml(letter)}</div></td>
        <td valign="top" style="padding-left:12px;">
          <p style="margin:0 0 3px 0;font-size:16px;font-weight:600;color:#1c1a15;${FONT}">${escapeHtml(r.title)}</p>
          <p style="margin:0;font-size:14px;line-height:1.5;color:#5c574a;${FONT}">${escapeHtml(r.body)}</p>
        </td>
        ${statCell}
      </tr></table>
    </td></tr>`;
}

function statStripHtml(stats: EmailStat[]): string {
  const cells = stats
    .map(
      (st, i) => `<td align="center" style="padding:6px 4px;${i > 0 ? "border-left:1px solid #ece8dd;" : ""}">
        <p style="margin:0 0 4px 0;font-size:24px;font-weight:700;color:${TONE_COLORS[st.tone ?? "neutral"]};${FONT}">${escapeHtml(st.value)}</p>
        <p style="margin:0;font-size:13px;color:#5c574a;${FONT}">${escapeHtml(st.label)}</p></td>`
    )
    .join("");
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:18px auto 0 auto;">
<tr><td style="background-color:#ffffff;border-radius:18px;padding:24px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>
</td></tr></table>`;
}

/**
 * Compose the plain-text and HTML bodies for one notification email.
 * Exactly one pill CTA (the lead card's, from primaryCta); every other card
 * gets a plain text link. Footer: reason line, preferences, unsubscribe,
 * mailing address.
 */
export function buildNotificationEmail(opts: {
  subject: string;
  preheader: string;
  /** Personalized greeting, e.g. "Hi Vivek,". */
  greeting?: string;
  /** Lowercase fragment completing the greeting, e.g. "here's what needs your attention this morning." */
  intro: string;
  sections: TemplateSection[];
  primaryCta: { label: string; url: string };
  reasonLine: string;
}): BuiltEmail {
  const { subject, preheader, intro, sections, primaryCta, reasonLine } = opts;
  const greeting = opts.greeting ?? "Hi there,";
  const cards = groupIntoCards(sections);

  // ---- plain text ----
  const textSections = cards
    .map((c) => {
      const rows = c.rows
        .map((r) => `${r.title}${r.stat ? ` — ${r.stat}` : ""}\n${r.body}`)
        .join("\n\n");
      const stats = c.stats.length
        ? c.stats.map((s) => `${s.value} ${s.label}`).join(" · ") + "\n\n"
        : "";
      return `${c.heading}\n${stats}${rows}\n${c.ctaLabel}: ${c.ctaUrl}`;
    })
    .join("\n\n");
  const text = [
    `${greeting} ${intro}`,
    "",
    textSections,
    "",
    "—",
    reasonLine,
    `Manage preferences: ${SETTINGS_URL}`,
    `Unsubscribe: ${SETTINGS_URL}`,
    MAILING_ADDRESS,
  ].join("\n");

  // ---- HTML ----
  const cardsHtml = cards
    .map((c, i) => {
      const rows = c.rows.map(rowHtml).join("");
      const cta =
        i === 0
          ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px auto 4px auto;"><tr>
          <td align="center" style="background-color:#1c1a15;border-radius:999px;">
            <a href="${escapeHtml(primaryCta.url)}" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;${FONT}">${escapeHtml(primaryCta.label)}</a>
          </td></tr></table>`
          : `<p style="margin:14px 0 2px 0;font-size:14px;${FONT}"><a href="${escapeHtml(c.ctaUrl)}" style="color:#2f6f4e;font-weight:600;text-decoration:underline;">${escapeHtml(c.ctaLabel)} &rarr;</a></p>`;
      const strip = c.stats.length ? statStripHtml(c.stats) : "";
      return `${strip}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:18px auto 0 auto;">
<tr><td style="background-color:#ffffff;border-radius:18px;padding:26px 32px;">
  <h2 style="margin:0 0 4px 0;font-size:20px;color:#1c1a15;${FONT}">${escapeHtml(c.heading)}</h2>
  <p style="margin:0 0 6px 0;font-size:14px;color:#5c574a;${FONT}">${escapeHtml(c.subhead)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  ${cta}
</td></tr></table>`;
    })
    .join("");

  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
  <body style="margin:0;padding:0;background-color:#f4f1ea;${FONT}">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
          <tr><td style="background-color:#2f6f4e;border-radius:18px 18px 0 0;padding:26px 28px 0 28px;">
            <p style="margin:0;font-size:15px;font-weight:800;letter-spacing:0.22em;color:#ffffff;${FONT}">COAST</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px 0 0 0;">
              <img src="${escapeHtml(HEADER_IMAGE_URL)}" alt="" width="544" style="display:block;width:100%;max-width:544px;height:auto;border-radius:12px;">
            </td></tr></table>
          </td></tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
          <tr><td style="background-color:#ffffff;border-radius:0 0 18px 18px;padding:30px 32px 10px 32px;">
            <h1 style="margin:0 0 10px 0;font-size:30px;line-height:1.2;color:#1c1a15;letter-spacing:-0.01em;${FONT}">${escapeHtml(subject)}</h1>
            <p style="margin:0 0 4px 0;font-size:15px;line-height:1.6;color:#5c574a;${FONT}">${escapeHtml(greeting)} ${escapeHtml(intro)}</p>
          </td></tr>
        </table>
        ${cardsHtml}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:18px auto 0 auto;">
          <tr><td style="padding:6px 32px 0 32px;">
            <p style="margin:0 0 6px 0;font-size:12px;line-height:1.6;color:#8a8474;${FONT}">${escapeHtml(reasonLine)}</p>
            <p style="margin:0 0 6px 0;font-size:12px;line-height:1.6;color:#8a8474;${FONT}">
              <a href="${escapeHtml(SETTINGS_URL)}" style="color:#8a8474;">Manage preferences</a>
              &nbsp;·&nbsp;
              <a href="${escapeHtml(SETTINGS_URL)}" style="color:#8a8474;">Unsubscribe</a>
            </p>
            <p style="margin:0;font-size:12px;line-height:1.6;color:#8a8474;${FONT}">${escapeHtml(MAILING_ADDRESS)}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Resend transport (log-only until configured)
// ---------------------------------------------------------------------------

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Full one-click URL (RFC 8058) minted per user by the caller. */
  listUnsubscribeUrl: string;
}

export type SendEmailResult = { status: "sent"; id: string } | { status: "skipped_no_provider" };

/**
 * Send one email via Resend. Returns skipped_no_provider (no throw, no
 * network) until RESEND_API_KEY and NOTIFICATIONS_FROM are both set —
 * the pipeline stays fully testable and log-only before launch.
 * Non-2xx from Resend throws so the caller can skip the user and continue.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATIONS_FROM;
  if (!apiKey || !from) {
    return { status: "skipped_no_provider" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html,
      headers: {
        "List-Unsubscribe": `<${input.listUnsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: unknown };
  return { status: "sent", id: typeof data.id === "string" ? data.id : "" };
}
