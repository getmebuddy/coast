/**
 * Notification email templates + Resend transport.
 *
 * SERVER ONLY in practice (the sweep route imports this). Templates are
 * plain-text-first in Coast voice: calm plain English, 2–3 sentences, the
 * number up front, one CTA button.
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

export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://coast-whitemattertechnologies-3980.vercel.app";

export const SETTINGS_URL = `${APP_URL}/settings/notifications`;

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

export interface TemplateSection {
  headline: string;
  body: string;
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

/**
 * Compose the plain-text and HTML bodies for one notification email.
 * Exactly one CTA button (the lead section's); remaining sections get
 * plain text links. Footer: preferences, unsubscribe, mailing address.
 */
export function buildNotificationEmail(opts: {
  subject: string;
  preheader: string;
  intro: string;
  sections: TemplateSection[];
  primaryCta: { label: string; url: string };
  reasonLine: string;
}): BuiltEmail {
  const { subject, preheader, intro, sections, primaryCta, reasonLine } = opts;

  const textSections = sections
    .map(
      (s) =>
        `${s.headline}\n${s.body}\n${s.ctaLabel}: ${s.ctaUrl}`
    )
    .join("\n\n");

  const text = [
    "Good morning.",
    "",
    intro,
    "",
    textSections,
    "",
    "—",
    reasonLine,
    `Manage preferences: ${SETTINGS_URL}`,
    `Unsubscribe: ${SETTINGS_URL}`,
    MAILING_ADDRESS,
  ].join("\n");

  const htmlSections = sections
    .map(
      (s) => `
        <tr>
          <td style="padding:14px 0;border-top:1px solid #e8e4da;">
            <p style="margin:0 0 6px 0;font-size:16px;font-weight:600;color:#1c1a15;">${escapeHtml(s.headline)}</p>
            <p style="margin:0 0 8px 0;font-size:14px;line-height:1.55;color:#4a463c;">${escapeHtml(s.body)}</p>
            <a href="${escapeHtml(s.ctaUrl)}" style="font-size:14px;color:#2f6f4e;text-decoration:underline;">${escapeHtml(s.ctaLabel)} &rarr;</a>
          </td>
        </tr>`
    )
    .join("");

  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background-color:#faf8f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;border:1px solid #e8e4da;">
            <tr>
              <td style="padding:28px 28px 8px 28px;">
                <p style="margin:0 0 4px 0;font-size:13px;font-weight:700;letter-spacing:0.08em;color:#2f6f4e;">COAST</p>
                <h1 style="margin:0 0 10px 0;font-size:22px;line-height:1.3;color:#1c1a15;">${escapeHtml(subject)}</h1>
                <p style="margin:0 0 6px 0;font-size:15px;line-height:1.6;color:#4a463c;">Good morning.</p>
                <p style="margin:0;font-size:15px;line-height:1.6;color:#4a463c;">${escapeHtml(intro)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${htmlSections}</table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 28px 8px 28px;">
                <a href="${escapeHtml(primaryCta.url)}" style="display:inline-block;padding:12px 28px;background-color:#2f6f4e;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">${escapeHtml(primaryCta.label)}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px 28px 28px;">
                <p style="margin:0 0 6px 0;font-size:12px;line-height:1.6;color:#8a8474;">${escapeHtml(reasonLine)}</p>
                <p style="margin:0 0 6px 0;font-size:12px;line-height:1.6;color:#8a8474;">
                  <a href="${escapeHtml(SETTINGS_URL)}" style="color:#8a8474;">Manage preferences</a>
                  &nbsp;·&nbsp;
                  <a href="${escapeHtml(SETTINGS_URL)}" style="color:#8a8474;">Unsubscribe</a>
                </p>
                <p style="margin:0;font-size:12px;line-height:1.6;color:#8a8474;">${escapeHtml(MAILING_ADDRESS)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
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
