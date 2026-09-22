import { describe, expect, it } from "vitest";
import {
  AUTH_CALLBACK_PATH,
  magicLinkRedirectTo,
  safePostAuthRedirect,
} from "./auth";

describe("magicLinkRedirectTo", () => {
  it("points magic links at the PKCE callback, not the home page", () => {
    expect(magicLinkRedirectTo("https://coast.example")).toBe(
      "https://coast.example/auth/callback"
    );
  });

  it("exposes the callback path as a constant", () => {
    expect(AUTH_CALLBACK_PATH).toBe("/auth/callback");
  });
});

describe("safePostAuthRedirect", () => {
  it("defaults to / when no next param is present", () => {
    expect(safePostAuthRedirect("https://coast.example/auth/callback?code=abc")).toBe("/");
  });

  it("allows same-origin paths", () => {
    expect(
      safePostAuthRedirect("https://coast.example/auth/callback?code=abc&next=/brief")
    ).toBe("/brief");
  });

  it("rejects absolute URLs (open-redirect protection)", () => {
    expect(
      safePostAuthRedirect(
        "https://coast.example/auth/callback?code=abc&next=https://evil.example"
      )
    ).toBe("/");
  });

  it("rejects protocol-relative URLs", () => {
    expect(
      safePostAuthRedirect("https://coast.example/auth/callback?code=abc&next=//evil.example")
    ).toBe("/");
  });

  it("falls back to / on malformed input", () => {
    expect(safePostAuthRedirect("not a url")).toBe("/");
  });
});
