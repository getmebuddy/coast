import { describe, expect, it } from "vitest";
import {
  buildNotificationEmail,
  HEADER_IMAGE_URL,
  SETTINGS_URL,
  type TemplateSection,
} from "./email-templates";

function section(over: Partial<TemplateSection> = {}): TemplateSection {
  return {
    type: "attention_digest",
    rows: [
      {
        title: "Hulu went up",
        body: "$7.99 to $9.99 a month.",
        stat: "+$2.00",
        tone: "negative",
        iconSeed: "Hulu",
      },
    ],
    ctaLabel: "Open your brief",
    ctaUrl: "https://example.com/click/1",
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildNotificationEmail>[0]> = {}) {
  return buildNotificationEmail({
    subject: "2 things need your attention",
    preheader: "Your Coast brief",
    greeting: "Hi Vivek,",
    intro: "here's what needs your attention this morning.",
    sections: [section()],
    primaryCta: { label: "Open your brief", url: "https://example.com/click/1" },
    reasonLine: "You're getting this because morning attention digests are on.",
    ...over,
  });
}

describe("buildNotificationEmail (v2 design)", () => {
  it("renders the green brand band and absolute header image URL", () => {
    const { html } = build();
    expect(html).toContain("background-color:#2f6f4e");
    expect(html).toContain(">COAST<");
    expect(html).toContain(`src="${HEADER_IMAGE_URL}"`);
    expect(HEADER_IMAGE_URL).toMatch(/^https:\/\//);
    expect(HEADER_IMAGE_URL).toContain("/email/header.png");
  });

  it("renders the subject as the big headline with the personalized subhead", () => {
    const { html } = build();
    expect(html).toContain("<h1");
    expect(html).toContain("2 things need your attention");
    expect(html).toContain("Hi Vivek,");
    expect(html).toContain("here's what needs your attention this morning.");
  });

  it("defaults the greeting to 'Hi there,' when omitted", () => {
    const { html, text } = build({ greeting: undefined });
    expect(html).toContain("Hi there,");
    expect(text).toContain("Hi there,");
  });

  it("escapes malicious content in subject, titles, and bodies", () => {
    const { html, text } = build({
      subject: 'Evil <script>alert("x")</script>',
      sections: [
        section({
          rows: [
            {
              title: '<img src=x onerror=alert(1)>',
              body: '"><svg onload=alert(2)>',
              stat: "<b>bold</b>",
              tone: "neutral",
              iconSeed: "Evil",
            },
          ],
        }),
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x");
    // Plain text is raw (no HTML to escape into), but must not gain tags.
    // Note: the email subject travels in the message header, not the body.
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(text).not.toContain("<table");
  });

  it("groups same-card sections into one card, in order", () => {
    const { html } = build({
      sections: [
        section({ type: "price_hike" }),
        section({
          type: "attention_digest",
          rows: [
            {
              title: "Watchlist: Whole Foods",
              body: "Over the limit.",
              stat: "$412",
              tone: "negative",
              iconSeed: "Whole Foods",
            },
          ],
          ctaLabel: "View watchlists",
          ctaUrl: "https://example.com/click/2",
        }),
        section({
          type: "charge_tomorrow",
          rows: [
            {
              title: "Netflix",
              body: "Renews tomorrow.",
              stat: "$15.49",
              tone: "neutral",
              iconSeed: "Netflix",
            },
          ],
          ctaLabel: "Review subscriptions",
          ctaUrl: "https://example.com/click/3",
        }),
      ],
    });
    const attentionCards = html.match(/>Needs your attention</g) ?? [];
    expect(attentionCards).toHaveLength(1);
    expect(html).toContain("Hulu went up");
    expect(html).toContain("Watchlist: Whole Foods");
    expect(html).toContain(">Charging tomorrow<");
  });

  it("renders exactly one pill CTA (the lead's); other cards get text links", () => {
    const { html } = build({
      sections: [
        section(),
        section({
          type: "charge_tomorrow",
          ctaLabel: "Review subscriptions",
          ctaUrl: "https://example.com/click/3",
        }),
      ],
      primaryCta: { label: "Open your brief", url: "https://example.com/click/1" },
    });
    const pills = html.match(/border-radius:999px/g) ?? [];
    expect(pills).toHaveLength(1);
    expect(html).toContain(">Open your brief</a>");
    expect(html).toContain(">Review subscriptions &rarr;</a>");
  });

  it("colors stats by tone", () => {
    const { html } = build({
      sections: [
        section(), // negative -> #b3541e
        section({
          type: "refund_landed",
          rows: [
            {
              title: "Refund landed",
              body: "Money back.",
              stat: "$84.20",
              tone: "positive",
              iconSeed: "Whole Foods",
            },
          ],
        }),
      ],
    });
    expect(html).toContain("color:#b3541e");
    expect(html).toContain("color:#2f6f4e");
  });

  it("renders the stat strip above the card when provided", () => {
    const { html, text } = build({
      sections: [
        section({
          type: "friday_recap",
          stats: [
            { value: "$1,240", label: "spent" },
            { value: "12", label: "purchases" },
          ],
        }),
      ],
    });
    expect(html).toContain("$1,240");
    expect(html).toContain(">spent<");
    expect(html).toContain("12");
    expect(html).toContain(">purchases<");
    expect(text).toContain("$1,240 spent · 12 purchases");
  });

  it("renders letter avatars deterministically", () => {
    const a = build().html;
    const b = build().html;
    expect(a).toContain(">H</div>");
    expect(a).toBe(b);
  });

  it("carries the reason line, preference links, and mailing address in the footer", () => {
    const { html, text } = build();
    expect(html).toContain("You're getting this because morning attention digests are on.");
    expect(html).toContain(">Manage preferences</a>");
    expect(html).toContain(">Unsubscribe</a>");
    expect(html).toContain(SETTINGS_URL);
    expect(text).toContain(`Manage preferences: ${SETTINGS_URL}`);
    expect(text).toContain(`Unsubscribe: ${SETTINGS_URL}`);
  });

  it("keeps the plain-text version in sync with the HTML content", () => {
    const { text } = build({
      sections: [section(), section({ type: "charge_tomorrow" })],
    });
    expect(text).toContain("Hi Vivek, here's what needs your attention this morning.");
    expect(text).toContain("Needs your attention");
    expect(text).toContain("Hulu went up — +$2.00");
    expect(text).toContain("$7.99 to $9.99 a month.");
    expect(text).toContain("Charging tomorrow");
    expect(text).toContain("Open your brief: https://example.com/click/1");
    expect(text).not.toContain("<table");
    expect(text).not.toContain("<a href");
  });

  it("hides the preheader from the visible body", () => {
    const { html } = build({ preheader: "sneak peek text" });
    expect(html).toContain("display:none");
    expect(html).toContain("sneak peek text");
  });
});

describe("monthly_spending_report card", () => {
  it("renders under the Monthly spending report heading with the stat strip", () => {
    const { html, text } = build({
      subject: "Your August spending report",
      primaryCta: { label: "See your spending", url: "https://example.com/click/9" },
      sections: [
        section({
          type: "monthly_spending_report",
          rows: [
            {
              title: "Net income",
              body: "You kept 36% of what you earned.",
              stat: "$1800",
              tone: "positive",
              iconSeed: "net",
            },
          ],
          stats: [
            { value: "$5000", label: "income" },
            { value: "$3200", label: "spent" },
            { value: "$1800", label: "net", tone: "positive" },
          ],
          ctaLabel: "See your spending",
          ctaUrl: "https://example.com/click/9",
        }),
      ],
    });
    expect(html).toContain("Monthly spending report");
    expect(html).toContain("Your August spending report");
    expect(html).toContain("$5000");
    expect(html).toContain("You kept 36% of what you earned.");
    expect(html).toContain("See your spending");
    expect(text).toContain("Monthly spending report");
    expect(text).toContain("See your spending: https://example.com/click/9");
  });
});
