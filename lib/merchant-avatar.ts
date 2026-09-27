/**
 * Merchant avatar helpers — pure functions behind <MerchantIcon>.
 *
 * Letter avatars get a deterministic muted background derived from the
 * merchant name, so the same merchant always renders the same color
 * everywhere (activity, budgets, brief, spending).
 */

/** Muted, white-text-safe palette. */
export const AVATAR_PALETTE = [
  "#5b7fa6", // slate blue
  "#6f8f6a", // sage
  "#8a6f9e", // muted violet
  "#a0835b", // warm tan
  "#9e6b74", // dusty rose
  "#5f8a8b", // teal
  "#7d6a8f", // plum
  "#8b7a5f", // bronze
] as const;

/** First displayable letter of the name, uppercased; "?" when none. */
export function avatarLetterFor(name: string): string {
  const m = (name ?? "").match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : "?";
}

/** Deterministic palette pick from the name (djb2 hash). */
export function avatarColorFor(name: string): string {
  const s = name ?? "";
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}
