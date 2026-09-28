/**
 * Tests for lib/push.ts — payload composition limits, subscription
 * validation, and delivery with expired-subscription cleanup.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

// web-push validates VAPID keys in setVapidDetails; mock the module so unit
// tests don't need real keys (the sweep's bad_config path is the prod guard).
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

import {
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  composePushPayload,
  deliverPush,
  isPushableType,
  safePushUrl,
  truncateAtWord,
  validatePushSubscription,
  vapidConfigured,
  type PushSubscriptionRow,
} from "./push";

type Db = Parameters<typeof deliverPush>[0];

function fakeDb(
  rows: PushSubscriptionRow[],
  opts?: { readError?: string }
): { db: Db; deleted: string[] } {
  const deleted: string[] = [];
  const db = {
    from: (table: string) => {
      if (table !== "push_subscriptions") throw new Error("unexpected table " + table);
      return {
        select: (_cols: string) => ({
          eq: async (_col: string, _val: string) =>
            opts?.readError
              ? { data: null, error: { message: opts.readError } }
              : { data: rows, error: null },
        }),
        delete: () => ({
          eq: async (_col: string, val: string) => {
            deleted.push(val);
            return { error: null };
          },
        }),
      };
    },
  } as unknown as Db;
  return { db, deleted };
}

const ROW: PushSubscriptionRow = {
  id: "sub-1",
  endpoint: "https://fcm.googleapis.com/fake/1",
  p256dh: "p256dh-key",
  auth: "auth-secret",
};

const PAYLOAD = {
  title: "Netflix bills $15.49 tomorrow",
  body: "Netflix charges $15.49 tomorrow. If you don't need it anymore, cancel before the charge posts.",
  url: "/subscriptions",
  tag: "charge:abc:2026-09-28",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("truncateAtWord", () => {
  it("leaves short strings alone", () => {
    expect(truncateAtWord("hello world", 110)).toBe("hello world");
  });
  it("truncates at a word boundary with an ellipsis, within the limit", () => {
    const out = truncateAtWord("word ".repeat(40).trim(), 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });
  it("collapses whitespace first", () => {
    expect(truncateAtWord("a\n\n  b", 10)).toBe("a b");
  });
});

describe("safePushUrl", () => {
  it("accepts app-relative paths", () => {
    expect(safePushUrl("/subscriptions")).toBe("/subscriptions");
    expect(safePushUrl("/brief?x=1")).toBe("/brief?x=1");
  });
  it("rejects absolute, protocol-relative, and traversal URLs", () => {
    expect(safePushUrl("https://evil.com")).toBe("/brief");
    expect(safePushUrl("//evil.com/x")).toBe("/brief");
    expect(safePushUrl("/../etc")).toBe("/brief");
    expect(safePushUrl("")).toBe("/brief");
  });
});

describe("composePushPayload", () => {
  it("enforces the title/body length limits", () => {
    const p = composePushPayload({
      title: "x".repeat(200),
      body: "y ".repeat(200),
      url: "/brief",
      tag: "t",
    });
    expect(p.title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
    expect(p.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
  });
  it("falls back safely on bad input", () => {
    const p = composePushPayload({ title: "", body: "", url: "https://evil.com", tag: "" });
    expect(p.title).toBe("Coast");
    expect(p.url).toBe("/brief");
  });
  it("truncates long tags", () => {
    const p = composePushPayload({ ...PAYLOAD, tag: "t".repeat(100) });
    expect(p.tag.length).toBeLessThanOrEqual(64);
  });
});

describe("isPushableType", () => {
  it("allows the four urgent standalone types", () => {
    for (const t of ["charge_tomorrow", "price_hike", "fee_alert", "trial_converting"]) {
      expect(isPushableType(t)).toBe(true);
    }
  });
  it("keeps digest/recap/milestone/refund/budget email-only", () => {
    for (const t of [
      "attention_digest",
      "budget_pace",
      "refund_landed",
      "friday_recap",
      "unusual_spend",
      "number_milestone",
    ]) {
      expect(isPushableType(t)).toBe(false);
    }
  });
});

describe("validatePushSubscription", () => {
  const valid = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: "k1", auth: "k2" },
  };
  it("accepts a well-formed subscription", () => {
    const r = validatePushSubscription(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sub.endpoint).toBe(valid.endpoint);
  });
  it("rejects non-object bodies", () => {
    expect(validatePushSubscription(null).ok).toBe(false);
    expect(validatePushSubscription("x").ok).toBe(false);
    expect(validatePushSubscription([]).ok).toBe(false);
  });
  it("requires an https endpoint", () => {
    expect(validatePushSubscription({ ...valid, endpoint: "http://x" }).ok).toBe(false);
    expect(validatePushSubscription({ ...valid, endpoint: 42 }).ok).toBe(false);
  });
  it("requires non-empty p256dh and auth", () => {
    expect(
      validatePushSubscription({ ...valid, keys: { p256dh: "", auth: "k2" } }).ok
    ).toBe(false);
    expect(validatePushSubscription({ ...valid, keys: { p256dh: "k1" } }).ok).toBe(false);
    expect(validatePushSubscription({ ...valid, keys: null }).ok).toBe(false);
  });
});

describe("vapidConfigured", () => {
  it("is false without keys", () => {
    expect(vapidConfigured()).toBe(false);
  });
  it("is true with both keys", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect(vapidConfigured()).toBe(true);
  });
  it("is false with only the public key", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "pub");
    expect(vapidConfigured()).toBe(false);
  });
});

describe("deliverPush", () => {
  function withKeys() {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "BPubKey");
    vi.stubEnv("VAPID_PRIVATE_KEY", "privKey");
  }

  it("is inert without VAPID keys", async () => {
    const { db } = fakeDb([ROW]);
    const sender = vi.fn().mockResolvedValue({});
    const r = await deliverPush(db, "user-1", PAYLOAD, sender);
    expect(r.skipped).toBe("not_configured");
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends to every subscription", async () => {
    withKeys();
    const { db } = fakeDb([ROW, { ...ROW, id: "sub-2" }]);
    const sender = vi.fn().mockResolvedValue({});
    const r = await deliverPush(db, "user-1", PAYLOAD, sender);
    expect(r).toMatchObject({ sent: 2, expired: 0, failed: 0, skipped: null });
    // Payload carries the composed title/body/url/tag.
    const sentPayload = JSON.parse(String(sender.mock.calls[0][1]));
    expect(sentPayload.title).toBe(PAYLOAD.title);
    expect(sentPayload.url).toBe("/subscriptions");
  });

  it("deletes expired subscriptions (404/410) and keeps the rest", async () => {
    withKeys();
    const { db, deleted } = fakeDb([ROW, { ...ROW, id: "sub-2" }]);
    const gone = Object.assign(new Error("gone"), { statusCode: 410 });
    const sender = vi
      .fn()
      .mockRejectedValueOnce(gone)
      .mockResolvedValueOnce({});
    const r = await deliverPush(db, "user-1", PAYLOAD, sender);
    expect(r).toMatchObject({ sent: 1, expired: 1, failed: 0 });
    expect(deleted).toEqual(["sub-1"]);
  });

  it("counts non-expired failures without deleting", async () => {
    withKeys();
    const { db, deleted } = fakeDb([ROW]);
    const boom = Object.assign(new Error("boom"), { statusCode: 503 });
    const sender = vi.fn().mockRejectedValue(boom);
    const r = await deliverPush(db, "user-1", PAYLOAD, sender);
    expect(r).toMatchObject({ sent: 0, expired: 0, failed: 1 });
    expect(deleted).toEqual([]);
  });

  it("skips cleanly with no subscriptions", async () => {
    withKeys();
    const { db } = fakeDb([]);
    const sender = vi.fn();
    const r = await deliverPush(db, "user-1", PAYLOAD, sender);
    expect(r.skipped).toBe("no_subscriptions");
    expect(sender).not.toHaveBeenCalled();
  });

  it("skips cleanly on db read failure", async () => {
    withKeys();
    const { db } = fakeDb([ROW], { readError: "db down" });
    const sender = vi.fn();
    const r = await deliverPush(db, "user-1", PAYLOAD, sender);
    expect(r.skipped).toBe("db_read");
    expect(sender).not.toHaveBeenCalled();
  });
});
