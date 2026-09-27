import { describe, expect, it } from "vitest";
import { SYNC_STALE_MS, shouldSync } from "./sync";

describe("shouldSync", () => {
  const now = new Date("2026-09-27T12:00:00Z").getTime();

  it("syncs when never synced", () => {
    expect(shouldSync(null, now)).toBe(true);
    expect(shouldSync(undefined, now)).toBe(true);
  });

  it("syncs when the timestamp is unparseable", () => {
    expect(shouldSync("not-a-date", now)).toBe(true);
  });

  it("syncs when older than the stale window", () => {
    const old = new Date(now - SYNC_STALE_MS - 1000).toISOString();
    expect(shouldSync(old, now)).toBe(true);
  });

  it("does not sync when fresh", () => {
    const fresh = new Date(now - 3600 * 1000).toISOString();
    expect(shouldSync(fresh, now)).toBe(false);
  });

  it("does not sync exactly at the boundary", () => {
    const boundary = new Date(now - SYNC_STALE_MS).toISOString();
    expect(shouldSync(boundary, now)).toBe(false);
  });

  it("handles future timestamps as fresh", () => {
    const future = new Date(now + 3600 * 1000).toISOString();
    expect(shouldSync(future, now)).toBe(false);
  });
});
