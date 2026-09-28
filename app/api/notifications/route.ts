import { NextResponse } from "next/server";
import { fail, getAuth } from "@/app/api/_lib/subscription-actions";
import { toNotificationCenterItem } from "@/lib/notifications";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const PAGE_SIZE = 20;

/**
 * GET /api/notifications — the signed-in user's recent notification rows,
 * newest first, enriched with deep links and unread flags. 401 fail-closed
 * for signed-out visitors (the bell renders nothing for them).
 */
export async function GET() {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { data, error } = await supabase
    .from("notification_log")
    .select("id, type, subject, channel, sent_at, read_at")
    .eq("user_id", user.id)
    .order("sent_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) {
    return NextResponse.json(
      { ok: false, error: "db-read", message: "Could not load notifications." },
      { status: 500, headers: NO_STORE }
    );
  }
  const items = (data ?? []).map(toNotificationCenterItem);
  const unread = items.filter((i) => i.unread).length;
  return NextResponse.json(
    { ok: true, data: { items, unread } },
    { headers: NO_STORE }
  );
}
