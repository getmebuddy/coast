import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Server Supabase client bound to the request's session cookies. */
export function createServerSupabase() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            /* route handlers may not always allow cookie writes */
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            /* ignore */
          }
        },
      },
    }
  );
}

/** Service-role client for server-side privileged work (sync pipeline).
 *  NEVER import this into client components.
 *  Typed identically to the session client so query code needs no changes. */
export function createServiceSupabase(): ReturnType<typeof createServerClient> {
  // Lazy require so the browser bundle never pulls @supabase/supabase-js service code.
  const { createClient } = require("@supabase/supabase-js");
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}
