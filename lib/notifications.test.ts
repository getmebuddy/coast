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
  isNotificationEnabled,
  isSweepWindow,
  isoWeekKey,
  localWeekday,
  milestoneKey,
  recapKey,
  refundKey,
  selectDigestSubject,
  startOfLocalDayUtc,
  todayKey,
  trialKey,
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
