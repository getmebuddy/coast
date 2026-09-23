import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
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
      // Backstop: every user_id column references profiles(id) — the
      // on_auth_user_created trigger normally creates it, but a missing
      // profile would break first-run writes (Plaid connect, Brief
      // read-state, budgets). Non-fatal: sign-in must never fail on this.
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const db = createServiceSupabase();
          await db
            .from("profiles")
            .upsert({ id: user.id }, { onConflict: "id", ignoreDuplicates: true });
        }
      } catch (e) {
        console.error("profile backstop failed (non-fatal)", e);
      }
      return NextResponse.redirect(new URL(next, request.url));
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", request.url));
}
