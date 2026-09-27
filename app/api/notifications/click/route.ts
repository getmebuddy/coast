import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { logPilotEvent } from "@/lib/analytics-server";
import { verifyClickToken } from "@/lib/notifications";
import { APP_URL } from "@/lib/email-templates";

/**
 * GET /api/notifications/click?token=… — email click tracking.
 *
 * No session auth needed: the signed token IS the auth (HMAC-SHA256 over
 * `${logId}|${targetPath}` with CRON_SECRET). Verifies the token, stamps
 * notification_log.clicked_at (first click wins), logs a
 * notification_clicked pilot event (buckets/labels only), and 302-redirects
 * to the in-app destination. Anything invalid → 400.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const secret = process.env.CRON_SECRET;
  if (!token || !secret) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const verified = await verifyClickToken(token, secret);
  if (!verified) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const db = createServiceSupabase();
  const { data: row } = await db
    .from("notification_log")
    .select("user_id, type")
    .eq("id", verified.logId)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // First click wins — subsequent clicks still redirect, just don't re-stamp.
  await db
    .from("notification_log")
    .update({ clicked_at: new Date().toISOString() })
    .eq("id", verified.logId)
    .is("clicked_at", null);

  await logPilotEvent(row.user_id as string, "notification_clicked", {
    type: String(row.type),
  });

  return NextResponse.redirect(APP_URL + verified.targetPath, 302);
}
