import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { verifyUnsubscribeToken } from "@/lib/notifications";
import { SETTINGS_URL } from "@/lib/email-templates";

/**
 * /api/notifications/unsubscribe — RFC 8058 one-click unsubscribe.
 *
 * POST ?t=<token>: verifies the HMAC-bound token (the token IS the auth —
 * no session needed, this is what email clients POST to) and sets
 * unsubscribed_all. GET redirects humans to the settings page.
 * Service-role only; the token never leaves the email it was minted for.
 */
export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get("t");
  const secret = process.env.CRON_SECRET;
  if (!token || !secret) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const userId = await verifyUnsubscribeToken(token, secret);
  if (!userId) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const db = createServiceSupabase();
  const { error } = await db.from("notification_prefs").upsert(
    {
      user_id: userId,
      unsubscribed_all: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    return NextResponse.json({ error: "unsubscribe failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, unsubscribed: true });
}

export async function GET() {
  // Humans who click through land on settings; the POST above is the
  // one-click path email clients use.
  return NextResponse.redirect(SETTINGS_URL, 302);
}
