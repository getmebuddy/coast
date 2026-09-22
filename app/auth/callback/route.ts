import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { safePostAuthRedirect } from "@/lib/auth";

/**
 * GET /auth/callback?code=...
 * Exchanges the Supabase PKCE code from a magic-link email for a session,
 * then sends the user home. Failures bounce back to /login.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safePostAuthRedirect(request.url);

  if (code) {
    const supabase = createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", request.url));
}
