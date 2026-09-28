import { NextResponse } from "next/server";
import { fail, getAuth } from "@/app/api/_lib/subscription-actions";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/notifications/unread-count — light endpoint for the header bell
 * badge. 401 fail-closed; the bell renders nothing when signed out.
 */
export async function GET() {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { count, error } = await supabase
    .from("notification_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("read_at", null);

  if (error) {
    return NextResponse.json(
      { ok: false, error: "db-read", message: "Could not count notifications." },
      { status: 500, headers: NO_STORE }
    );
  }
  return NextResponse.json(
    { ok: true, data: { unread: count ?? 0 } },
    { headers: NO_STORE }
  );
}
