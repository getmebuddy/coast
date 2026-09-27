import { describe, expect, it } from "vitest";
import { AVATAR_PALETTE, avatarColorFor, avatarLetterFor } from "./merchant-avatar";

describe("avatarLetterFor", () => {
  it("uppercases the first alphanumeric character", () => {
    expect(avatarLetterFor("netflix")).toBe("N");
    expect(avatarLetterFor("Whole Foods")).toBe("W");
    expect(avatarLetterFor(" 7-eleven")).toBe("7");
  });

  it("falls back to ? for empty or non-alphanumeric names", () => {
    expect(avatarLetterFor("")).toBe("?");
    expect(avatarLetterFor("   ")).toBe("?");
    expect(avatarLetterFor("···")).toBe("?");
  });
});

describe("avatarColorFor", () => {
  it("is deterministic per name", () => {
    expect(avatarColorFor("Netflix")).toBe(avatarColorFor("Netflix"));
    expect(avatarColorFor("")).toBe(avatarColorFor(""));
  });

  it("always picks from the fixed palette", () => {
    for (const name of ["Netflix", "Whole Foods", "A", "x".repeat(200), "Café ☕"]) {
      expect(AVATAR_PALETTE).toContain(avatarColorFor(name));
    }
  });

  it("distributes across the palette", () => {
    const colors = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "netflix", "spotify", "delta"].map(
        avatarColorFor
      )
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});
