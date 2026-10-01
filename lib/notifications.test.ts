/**
 * Tests for the notification sweep's pure logic (lib/notifications.ts).
 *
 * Timezone-sensitive tests use fixed instants so they are DST-safe:
 * - 2026-09-27 is a Sunday (CDT, UTC-5)
 * - 2026-01-15 is a Thursday (CST, UTC-6)
 * - 2026-03-08 is the US spring-forward day
 */
import { describe, expect, it } from "vitest";
import {
  MAX_EMAILS_PER_DAY,
  addDays,
  anomalyKey,
  applyCaps,
  budgetKey,
  buildClickToken,
  buildUnsubscribeToken,
  chargeKey,
  digestKey,
  feeKey,
  foldUrgentIntoDigest,
  formatDollars,
  hikeKey,
  isFirstOfMonth,
  isNotificationEnabled,
  isSweepWindow,
  isoWeekKey,
  localWeekday,
  milestoneKey,
  monthlyReportPush,
  monthlyReportSections,
  monthlyReportSubject,
  NOTIFICATION_TYPES,
  previousMonthKey,
  recapKey,
  refundKey,
  selectDigestSubject,
  spendingReportKey,
  startOfLocalDayUtc,
  todayKey,
  toNotificationCenterItem,
  trialKey,
  notificationDeepLink,
  verifyClickToken,
  verifyUnsubscribeToken,
  type ComposedEmail,
  type EmailSection,
} from "./notifications";

const CHI = "America/Chicago";
const NYC = "America/New_York";

function section(partial: Partial<EmailSection> & { headline: string }): EmailSection {
  return {
    type: "attention_digest",
    leadKind: null,
    body: "body",
    ctaLabel: "Open Morning Brief",
    ctaTarget: "/brief",
    ...partial,
  };
}

function email(partial: Partial<ComposedEmail> & { type: string; dedupeKey: string }): ComposedEmail {
  return { subject: "subject", sections: [], ...partial };
}

describe("isSweepWindow", () => {
  it("is true at exactly 06:45 local", () => {
    // 11:45 UTC = 06:45 CDT
    expect(isSweepWindow(CHI, new Date("2026-09-27T11:45:00.000Z"))).toBe(true);
  });

  it("is false one second before the window opens", () => {
    expect(isSweepWindow(CHI, new Date("2026-09-27T11:44:59.000Z"))).toBe(false);
  });

  it("is true at 06:59 local", () => {
    expect(isSweepWindow(CHI, new Date("2026-09-27T11:59:59.000Z"))).toBe(true);
  });

  it("is false at exactly 07:00 local (window is half-open)", () => {
    expect(isSweepWindow(CHI, new Date("2026-09-27T12:00:00.000Z"))).toBe(false);
  });

  it("respects the user's own timezone, not UTC", () => {
    // 10:45 UTC = 06:45 EDT in New York, but 05:45 CDT in Chicago
    const at = new Date("2026-09-27T10:45:00.000Z");
    expect(isSweepWindow(NYC, at)).toBe(true);
    expect(isSweepWindow(CHI, at)).toBe(false);
  });

  it("is DST-safe in winter (CST, UTC-6)", () => {
    // 12:45 UTC = 06:45 CST
    expect(isSweepWindow(CHI, new Date("2026-01-15T12:45:00.000Z"))).toBe(true);
    expect(isSweepWindow(CHI, new Date("2026-01-15T12:44:00.000Z"))).toBe(false);
  });

  it("is DST-safe on the spring-forward day", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00; 06:45 local is CDT (UTC-5)
    expect(isSweepWindow(CHI, new Date("2026-03-08T11:45:00.000Z"))).toBe(true);
  });

  it("returns false for an invalid timezone", () => {
    expect(isSweepWindow("Not/AZone", new Date("2026-09-27T11:50:00.000Z"))).toBe(false);
    expect(isSweepWindow("", new Date("2026-09-27T11:50:00.000Z"))).toBe(false);
  });
});

describe("todayKey", () => {
  it("returns the local calendar date, not the UTC date", () => {
    // 04:00 UTC Sep 27 = 23:00 CDT Sep 26
    expect(todayKey(CHI, new Date("2026-09-27T04:00:00.000Z"))).toBe("2026-09-26");
    expect(todayKey(CHI, new Date("2026-09-27T05:00:00.000Z"))).toBe("2026-09-27");
  });

  it("formats as YYYY-MM-DD", () => {
    expect(todayKey(CHI, new Date("2026-01-05T14:00:00.000Z"))).toBe("2026-01-05");
  });
});

describe("startOfLocalDayUtc", () => {
  it("is 05:00 UTC for a CDT day", () => {
    expect(startOfLocalDayUtc(CHI, new Date("2026-09-27T12:00:00.000Z")).toISOString()).toBe(
      "2026-09-27T05:00:00.000Z"
    );
  });

  it("is 06:00 UTC for a CST day", () => {
    expect(startOfLocalDayUtc(CHI, new Date("2026-01-15T12:00:00.000Z")).toISOString()).toBe(
      "2026-01-15T06:00:00.000Z"
    );
  });
});

describe("localWeekday / isoWeekKey / addDays", () => {
  it("names the local weekday", () => {
    expect(localWeekday(CHI, new Date("2026-09-27T12:00:00.000Z"))).toBe("Sunday");
    expect(localWeekday(CHI, new Date("2026-10-02T12:00:00.000Z"))).toBe("Friday");
  });

  it("computes ISO week keys, including year boundaries", () => {
    expect(isoWeekKey(CHI, new Date("2026-09-27T12:00:00.000Z"))).toBe("2026-W39");
    expect(isoWeekKey(CHI, new Date("2026-10-02T12:00:00.000Z"))).toBe("2026-W40");
    expect(isoWeekKey(CHI, new Date("2026-01-01T12:00:00.000Z"))).toBe("2026-W01");
    // 2025-12-31 (Wed) belongs to ISO week 1 of 2026
    expect(isoWeekKey(CHI, new Date("2025-12-31T12:00:00.000Z"))).toBe("2026-W01");
  });

  it("adds and subtracts days across month boundaries", () => {
    expect(addDays("2026-09-27", 1)).toBe("2026-09-28");
    expect(addDays("2026-09-27", -1)).toBe("2026-09-26");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("formatDollars", () => {
  it("drops cents for whole dollars, matching the copy deck", () => {
    expect(formatDollars(3500)).toBe("$35");
    expect(formatDollars(1549)).toBe("$15.49");
    expect(formatDollars(999)).toBe("$9.99");
    expect(formatDollars(0)).toBe("$0");
    expect(formatDollars(100)).toBe("$1");
  });
});

describe("isNotificationEnabled", () => {
  it("defaults to true when prefs are missing", () => {
    expect(isNotificationEnabled(null, "attention_digest")).toBe(true);
    expect(isNotificationEnabled(undefined, "attention_digest")).toBe(true);
  });

  it("defaults to true when the type has no explicit key", () => {
    expect(isNotificationEnabled({ prefs: {}, unsubscribed_all: false }, "fee_alert")).toBe(true);
  });

  it("returns false for an explicit opt-out", () => {
    const prefs = { prefs: { fee_alert: false }, unsubscribed_all: false };
    expect(isNotificationEnabled(prefs, "fee_alert")).toBe(false);
    expect(isNotificationEnabled(prefs, "charge_tomorrow")).toBe(true);
  });

  it("returns false for everything when unsubscribed_all", () => {
    const prefs = { prefs: {}, unsubscribed_all: true };
    expect(isNotificationEnabled(prefs, "attention_digest")).toBe(false);
    expect(isNotificationEnabled(prefs, "charge_tomorrow")).toBe(false);
  });
});

describe("selectDigestSubject", () => {
  const charge = (merchant: string, amountCents: number) =>
    section({ type: "charge_tomorrow", leadKind: "charge_tomorrow", merchant, amountCents, headline: "h" });
  const fee = (amountCents: number, accountLabel?: string) =>
    section({ type: "fee_alert", leadKind: "fee", amountCents, accountLabel, headline: "h" });
  const hike = (merchant: string, amountCents: number) =>
    section({ type: "price_hike", leadKind: "price_hike", merchant, amountCents, headline: "h" });
  const plain = () => section({ headline: "Something needs attention" });

  it("leads with the charge-tomorrow item (copy deck)", () => {
    const r = selectDigestSubject([plain(), charge("Netflix", 1549)]);
    expect(r.subject).toBe("Netflix bills $15.49 tomorrow");
    expect(r.leadType).toBe("charge_tomorrow");
  });

  it("prefers the largest charge when several bill tomorrow", () => {
    const r = selectDigestSubject([charge("Hulu", 999), charge("Netflix", 1549)]);
    expect(r.subject).toBe("Netflix bills $15.49 tomorrow");
  });

  it("leads with the fee when no charge is pending (copy deck)", () => {
    const r = selectDigestSubject([plain(), hike("Hulu", 999), fee(3500, "your Chase account")]);
    expect(r.subject).toBe("A $35 fee hit your Chase account");
    expect(r.leadType).toBe("fee_alert");
  });

  it("defaults the fee account label to 'your account'", () => {
    const r = selectDigestSubject([fee(3500)]);
    expect(r.subject).toBe("A $35 fee hit your account");
  });

  it("leads with the price hike when no charge or fee (copy deck)", () => {
    const r = selectDigestSubject([plain(), hike("Hulu", 999)]);
    expect(r.subject).toBe("Hulu raised its price to $9.99");
    expect(r.leadType).toBe("price_hike");
  });

  it("falls back to the findings count (copy deck)", () => {
    expect(selectDigestSubject([plain(), plain()])).toEqual({
      subject: "2 things need your attention",
      leadType: "attention_digest",
    });
  });

  it("singularizes the count lead", () => {
    expect(selectDigestSubject([plain()]).subject).toBe("1 thing needs your attention");
  });
});

describe("applyCaps", () => {
  const pending = (n: number) =>
    Array.from({ length: n }, (_, i) => email({ type: "t", dedupeKey: `k${i}` }));

  it("sends up to 2 per day", () => {
    const r = applyCaps(0, pending(3));
    expect(r.send).toHaveLength(2);
    expect(r.defer).toHaveLength(1);
    expect(r.defer[0].dedupeKey).toBe("k2");
  });

  it("defers everything once 2 have already been sent", () => {
    const r = applyCaps(2, pending(2));
    expect(r.send).toHaveLength(0);
    expect(r.defer).toHaveLength(2);
  });

  it("sends the remainder when 1 was already sent", () => {
    const r = applyCaps(1, pending(3));
    expect(r.send).toHaveLength(1);
    expect(r.defer).toHaveLength(2);
  });

  it("treats invalid counts as zero", () => {
    expect(applyCaps(NaN, pending(2)).send).toHaveLength(2);
    expect(applyCaps(-5, pending(2)).send).toHaveLength(2);
  });

  it("keeps pending order — the digest (first) is never the deferred one", () => {
    const r = applyCaps(0, pending(3));
    expect(r.send[0].dedupeKey).toBe("k0");
    expect(r.send[1].dedupeKey).toBe("k1");
  });

  it("exposes the daily max", () => {
    expect(MAX_EMAILS_PER_DAY).toBe(2);
  });
});

describe("foldUrgentIntoDigest", () => {
  it("produces ONE email with urgent sections first and a re-selected subject", () => {
    const digest = email({
      type: "attention_digest",
      dedupeKey: "digest:u:2026-09-27",
      subject: "2 things need your attention",
      sections: [section({ headline: "Price hike" }), section({ headline: "Budget hot" })],
    });
    const urgents = [
      email({
        type: "fee_alert",
        dedupeKey: "fee:hash",
        subject: "fee",
        sections: [
          section({ type: "fee_alert", leadKind: "fee", amountCents: 3500, headline: "Fee" }),
        ],
      }),
      email({
        type: "charge_tomorrow",
        dedupeKey: "charge:r:2026-09-28",
        subject: "charge",
        sections: [
          section({
            type: "charge_tomorrow",
            leadKind: "charge_tomorrow",
            merchant: "Netflix",
            amountCents: 1549,
            headline: "Charge",
          }),
        ],
      }),
    ];
    const folded = foldUrgentIntoDigest(digest, urgents);
    expect(folded.sections).toHaveLength(4);
    expect(folded.sections[0].headline).toBe("Fee");
    expect(folded.sections[1].headline).toBe("Charge");
    expect(folded.sections[2].headline).toBe("Price hike");
    // Charge outranks fee in the subject priority
    expect(folded.subject).toBe("Netflix bills $15.49 tomorrow");
    expect(folded.type).toBe("attention_digest");
    expect(folded.dedupeKey).toBe("digest:u:2026-09-27");
  });

  it("is a no-op subject-wise when there are no urgents", () => {
    const digest = email({
      type: "attention_digest",
      dedupeKey: "d",
      subject: "2 things need your attention",
      sections: [section({ headline: "A" }), section({ headline: "B" })],
    });
    const folded = foldUrgentIntoDigest(digest, []);
    expect(folded.sections).toHaveLength(2);
    expect(folded.subject).toBe("2 things need your attention");
  });
});

describe("dedupe keys", () => {
  it("matches the spec formats exactly", () => {
    const uid = "11111111-2222-3333-4444-555555555555";
    expect(digestKey(uid, "2026-09-27")).toBe(`digest:${uid}:2026-09-27`);
    expect(chargeKey("rec-1", "2026-09-28")).toBe("charge:rec-1:2026-09-28");
    expect(feeKey("fee_sweep:2026-09")).toBe("fee:fee_sweep:2026-09");
    expect(trialKey("Netflix", "2026-09-30")).toBe("trial:Netflix:2026-09-30");
    expect(recapKey(uid, "2026-W39")).toBe(`recap:${uid}:2026-W39`);
    expect(milestoneKey(uid, "50")).toBe(`milestone:${uid}:50`);
    expect(refundKey("refund_received:abc")).toBe("refund:refund_received:abc");
    expect(anomalyKey("anomaly:xyz")).toBe("anomaly:anomaly:xyz");
    expect(budgetKey("Dining", "2026-09-01")).toBe("budget:Dining:2026-09-01");
    expect(hikeKey("price_hike:Netflix:1549:1699")).toBe("hike:price_hike:Netflix:1549:1699");
  });
});

describe("click tokens", () => {
  const SECRET = "test-cron-secret";
  const LOG_ID = "11111111-2222-3333-4444-555555555555";

  it("round-trips build -> verify", async () => {
    const token = await buildClickToken(LOG_ID, "/brief", SECRET);
    expect(await verifyClickToken(token, SECRET)).toEqual({ logId: LOG_ID, targetPath: "/brief" });
  });

  it("rejects a tampered token", async () => {
    const token = await buildClickToken(LOG_ID, "/brief", SECRET);
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(await verifyClickToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const token = await buildClickToken(LOG_ID, "/brief", SECRET);
    expect(await verifyClickToken(token, "other-secret")).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyClickToken("not-a-token", SECRET)).toBeNull();
    expect(await verifyClickToken("", SECRET)).toBeNull();
  });

  it("refuses to build tokens for absolute URLs (open-redirect guard)", async () => {
    await expect(buildClickToken(LOG_ID, "https://evil.example/x", SECRET)).rejects.toThrow();
    await expect(buildClickToken(LOG_ID, "//evil.example/x", SECRET)).rejects.toThrow();
    await expect(buildClickToken(LOG_ID, "brief", SECRET)).rejects.toThrow();
  });

  it("rejects non-UUID log ids at build time", async () => {
    await expect(buildClickToken("not-a-uuid", "/brief", SECRET)).rejects.toThrow();
  });
});

describe("unsubscribe tokens", () => {
  const SECRET = "test-cron-secret";
  const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("round-trips build -> verify", async () => {
    const token = await buildUnsubscribeToken(USER_ID, SECRET);
    expect(await verifyUnsubscribeToken(token, SECRET)).toBe(USER_ID);
  });

  it("rejects a tampered token", async () => {
    const token = await buildUnsubscribeToken(USER_ID, SECRET);
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(await verifyUnsubscribeToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const token = await buildUnsubscribeToken(USER_ID, SECRET);
    expect(await verifyUnsubscribeToken(token, "other-secret")).toBeNull();
  });

  it("rejects garbage and non-UUID user ids", async () => {
    expect(await verifyUnsubscribeToken("not-a-token", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken("", SECRET)).toBeNull();
    await expect(buildUnsubscribeToken("not-a-uuid", SECRET)).rejects.toThrow();
  });
});

describe("notificationDeepLink", () => {
  it("maps every catalog type to an exact in-app surface", () => {
    expect(notificationDeepLink("attention_digest")).toBe("/brief");
    expect(notificationDeepLink("charge_tomorrow")).toBe("/subscriptions");
    expect(notificationDeepLink("price_hike")).toBe("/subscriptions");
    expect(notificationDeepLink("budget_pace")).toBe("/spending");
    expect(notificationDeepLink("fee_alert")).toBe("/transactions");
    expect(notificationDeepLink("refund_landed")).toBe("/transactions");
    expect(notificationDeepLink("friday_recap")).toBe("/brief");
    expect(notificationDeepLink("unusual_spend")).toBe("/spending");
    expect(notificationDeepLink("trial_converting")).toBe("/subscriptions");
    expect(notificationDeepLink("number_milestone")).toBe("/number");
  });

  it("covers every type in NOTIFICATION_TYPES (no drift)", () => {
    for (const t of NOTIFICATION_TYPES) {
      expect(notificationDeepLink(t.id)).toMatch(/^\/(brief|subscriptions|spending|transactions|number)$/);
    }
  });

  it("falls back to /brief for unknown types", () => {
    expect(notificationDeepLink("something_new")).toBe("/brief");
    expect(notificationDeepLink("")).toBe("/brief");
  });
});

describe("toNotificationCenterItem", () => {
  const row = {
    id: "row-1",
    type: "price_hike",
    subject: "Hulu went up $2",
    channel: "email",
    sent_at: "2026-09-28T12:00:00Z",
    read_at: null,
  };

  it("enriches with the catalog name, deep link, and unread flag", () => {
    const item = toNotificationCenterItem(row);
    expect(item.typeName).toBe("Price-hike alerts");
    expect(item.href).toBe("/subscriptions");
    expect(item.unread).toBe(true);
  });

  it("marks rows with read_at set as read", () => {
    const item = toNotificationCenterItem({ ...row, read_at: "2026-09-28T13:00:00Z" });
    expect(item.unread).toBe(false);
  });

  it("falls back to the raw type id for unknown types", () => {
    const item = toNotificationCenterItem({ ...row, type: "future_type" });
    expect(item.typeName).toBe("future_type");
    expect(item.href).toBe("/brief");
  });
});

describe("monthly_spending_report", () => {
  const summary = {
    monthKey: "2026-08",
    monthLabel: "August",
    incomeCents: 500000,
    spendCents: 320000,
    netCents: 180000,
    txnCount: 42,
    categories: [
      { category: "Groceries", spendCents: 80000, txnCount: 12, top: [] },
      { category: "Dining", spendCents: 60000, txnCount: 9, top: [] },
      { category: "Transport", spendCents: 50000, txnCount: 8, top: [] },
      { category: "Shopping", spendCents: 40000, txnCount: 5, top: [] },
      { category: "Utilities", spendCents: 30000, txnCount: 4, top: [] },
      { category: "Other-stuff", spendCents: 60000, txnCount: 4, top: [] },
    ],
    biggestTxn: { merchant: "Whole Foods", date: "2026-08-14", amountCents: 18432 },
  };

  it("is registered in the catalog as a phase-1 digest, default on", () => {
    const t = NOTIFICATION_TYPES.find((x) => x.id === "monthly_spending_report")!;
    expect(t).toMatchObject({
      name: "Monthly spending report",
      phase: 1,
      class: "digest",
      defaultOn: true,
    });
    expect(notificationDeepLink("monthly_spending_report")).toBe("/spending");
  });

  it("is gated by prefs like every other type", () => {
    expect(isNotificationEnabled({ prefs: {}, unsubscribed_all: false }, "monthly_spending_report")).toBe(true);
    expect(
      isNotificationEnabled(
        { prefs: { monthly_spending_report: false }, unsubscribed_all: false },
        "monthly_spending_report"
      )
    ).toBe(false);
    expect(
      isNotificationEnabled({ prefs: {}, unsubscribed_all: true }, "monthly_spending_report")
    ).toBe(false);
  });

  it("dedupes one report per calendar month", () => {
    expect(spendingReportKey("u1", "2026-08")).toBe("spending_report:u1:2026-08");
    expect(spendingReportKey("u1", "2026-09")).not.toBe(spendingReportKey("u1", "2026-08"));
  });

  it("detects the 1st and the just-ended month across a year boundary", () => {
    // 2026-10-01 12:00 UTC = 07:00 CDT — inside the sweep window on the 1st
    const first = new Date("2026-10-01T12:00:00Z");
    expect(isFirstOfMonth(CHI, first)).toBe(true);
    expect(previousMonthKey(CHI, first)).toBe("2026-09");
    expect(isFirstOfMonth(CHI, new Date("2026-10-02T12:00:00Z"))).toBe(false);
    // January 1st rolls back to December of the prior year
    const jan1 = new Date("2026-01-01T13:00:00Z"); // 07:00 CST
    expect(isFirstOfMonth(CHI, jan1)).toBe(true);
    expect(previousMonthKey(CHI, jan1)).toBe("2025-12");
  });

  it("builds the subject from the month label", () => {
    expect(monthlyReportSubject(summary)).toBe("Your August spending report");
  });

  it("composes the stat strip, comparison, finish-line, top-5, and biggest txn", () => {
    const sections = monthlyReportSections(summary, 1000000);
    expect(sections[0].type).toBe("monthly_spending_report");
    expect(sections[0].stats).toEqual([
      { value: "$5000", label: "income" },
      { value: "$3200", label: "spent" },
      { value: "$1800", label: "net", tone: "positive" },
    ]);
    expect(sections[0].body).toBe("You kept 36% of what you earned.");
    expect(sections[0].ctaLabel).toBe("See your spending");
    expect(sections[0].ctaTarget).toBe("/spending");

    const pace = sections[1];
    expect(pace.headline).toBe("Finish-line pace");
    expect(pace.body).toBe(
      "Your finish-line pace is $10,000/mo — you spent $3,200, $6,800 under."
    );

    const cats = sections.slice(2, 7);
    expect(cats.map((s) => s.headline)).toEqual([
      "Groceries",
      "Dining",
      "Transport",
      "Shopping",
      "Utilities",
    ]);
    expect(cats.every((s) => s.ctaTarget === "/spending")).toBe(true);

    const biggest = sections[7];
    expect(biggest.headline).toBe("Whole Foods");
    expect(biggest.body).toContain("2026-08-14");
    expect(sections).toHaveLength(8);
  });

  it("omits the finish-line row when FIRE settings are missing", () => {
    const sections = monthlyReportSections(summary, null);
    expect(sections.some((s) => s.headline === "Finish-line pace")).toBe(false);
  });

  it("tones a negative net as negative and says so", () => {
    const neg = { ...summary, spendCents: 600000, netCents: -100000 };
    const sections = monthlyReportSections(neg, null);
    expect(sections[0].tone).toBe("negative");
    expect(sections[0].body).toBe("You spent 20% more than you earned.");
  });

  it("falls back gracefully when no income landed", () => {
    const noIncome = { ...summary, incomeCents: 0, netCents: -320000 };
    const sections = monthlyReportSections(noIncome, null);
    expect(sections[0].body).toBe("No income landed in August — spending only.");
  });

  it("builds a short push teaser pointing at /spending", () => {
    const push = monthlyReportPush(summary);
    expect(push.title).toBe("Your August report is ready");
    expect(push.body.length).toBeLessThanOrEqual(110);
    expect(push.body).toContain("$3200");
  });
});
