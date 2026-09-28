import { NextResponse } from "next/server";
import { fail, getAuth, readJsonBody } from "@/app/api/_lib/subscription-actions";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/notifications/read — mark notification rows read.
 * Body: { all: true } marks every unread row read; or { ids: string[] }
 * marks specific rows. Always scoped to the caller's own rows; 401
 * fail-closed for signed-out visitors.
 */
export async function POST(req: Request) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { body, error: jsonError } = await readJsonBody(req);
  if (jsonError) return jsonError;

  const markAll = body?.all === true;
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (!markAll && ids.length === 0) {
    return fail("invalid_request", "Provide { all: true } or a non-empty ids array.", 400);
  }

  const now = new Date().toISOString();
  let query = supabase
    .from("notification_log")
    .update({ read_at: now })
    .eq("user_id", user.id)
    .is("read_at", null);
  if (!markAll) {
    query = query.in("id", ids.slice(0, 100));
  }
  const { error } = await query;
  if (error) {
    return NextResponse.json(
      { ok: false, error: "db-write", message: "Could not mark notifications read." },
      { status: 500, headers: NO_STORE }
    );
  }
  return NextResponse.json({ ok: true, data: { read: true } }, { headers: NO_STORE });
}
