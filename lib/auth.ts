/**
 * Auth helpers — magic-link callback routing and safe post-auth redirects.
 *
 * Supabase sends magic links as PKCE `?code=` URLs. The code must be
 * exchanged server-side at /auth/callback; landing anywhere else leaves the
 * user signed out (and on iOS the unhandled redirect surfaces as "Load Failed").
 */

export const AUTH_CALLBACK_PATH = "/auth/callback";

/** Where "email me a magic link" links should land so the code gets exchanged. */
export function magicLinkRedirectTo(origin: string): string {
  return `${origin}${AUTH_CALLBACK_PATH}`;
}

/**
 * Resolve where to send the user after a successful code exchange.
 * Only allows same-origin paths ("/", "/brief", ...); anything else,
 * including protocol-relative "//evil" tricks, falls back to "/".
 */
export function safePostAuthRedirect(requestUrl: string, fallback = "/"): string {
  try {
    const next = new URL(requestUrl).searchParams.get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) {
      return next;
    }
  } catch {
    /* malformed URL -> fall through */
  }
  return fallback;
}
