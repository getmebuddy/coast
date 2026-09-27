/**
 * GET /api/notifications/prefs — the caller's notification preferences:
 * { prefs, unsubscribed_all }. prefs: { "<type>": false }; absent = default ON.
 * Upserts the row if missing so the first GET creates defaults.
 *
 * PUT /api/notifications/prefs — accepts { prefs?, unsubscribed_all? }.
 * Every prefs key must be one of the 10 catalog ids and every value a
 * boolean; stored prefs are normalized to keep only explicit `false`s
 * (toggling a type back ON deletes its key).
 *
 * Session auth, 401 fail-closed. Notify-only: prefs change what Coast tells
 * you, never what it does.
 */
import { fail, getAuth, ok } from "@/app/api/_lib/subscription-actions";
import type { createServerSupabase } from "@/lib/supabase/server";
import { NOTIFICATION_TYPE_IDS } from "@/lib/notifications";

interface PrefsRow {
  prefs: Record<string, boolean> | null;
  unsubscribed_all: boolean | null;
}

type SessionSupabase = ReturnType<typeof createServerSupabase>;

async function readRow(
  supabase: SessionSupabase,
  userId: string
): Promise<{ row: PrefsRow | null; error: unknown }> {
  const { data, error } = await supabase
    .from("notification_prefs")
    .select("prefs, unsubscribed_all")
    .eq("user_id", userId)
    .maybeSingle();
  return { row: (data as PrefsRow | null) ?? null, error };
}

export async function GET() {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  let { row, error } = await readRow(supabase, user.id);
  if (error) return fail("db-read", "Could not load notification preferences.", 500);

  // First visit: create the defaults row.
  if (!row) {
    const created = await supabase
      .from("notification_prefs")
      .insert({ user_id: user.id })
      .select("prefs, unsubscribed_all")
      .single();
    if (created.error)
      return fail("db-write", "Could not set up notification preferences.", 500);
    row = (created.data as PrefsRow | null) ?? null;
  }
  if (!row) return fail("db-read", "Could not load notification preferences.", 500);

  return ok({
    prefs: row.prefs ?? {},
    unsubscribed_all: row.unsubscribed_all ?? false,
  });
}

export async function PUT(req: Request) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_json", "Request body must be valid JSON.", 400);
  }
  const { prefs, unsubscribed_all } = body ?? {};

  let normalized: Record<string, boolean> | undefined;
  if (prefs !== undefined) {
    if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) {
      return fail("invalid_prefs", "prefs must be an object of notification type ids to booleans.", 400);
    }
    for (const [key, value] of Object.entries(prefs)) {
      if (!NOTIFICATION_TYPE_IDS.has(key)) {
        return fail("unknown_notification_type", `Unknown notification type: ${key}.`, 400);
      }
      if (typeof value !== "boolean") {
        return fail(
          "invalid_pref_value",
          `Preference for ${key} must be true or false.`,
          400
        );
      }
    }
    // Absent = default ON, so only explicit `false`s are worth storing.
    normalized = Object.fromEntries(
      Object.entries(prefs).filter(([, v]) => v === false)
    ) as Record<string, boolean>;
  }
  if (
    unsubscribed_all !== undefined &&
    typeof unsubscribed_all !== "boolean"
  ) {
    return fail("invalid_unsubscribed_all", "unsubscribed_all must be true or false.", 400);
  }
  if (normalized === undefined && unsubscribed_all === undefined) {
    return fail("no_changes", "Provide prefs and/or unsubscribed_all to update.", 400);
  }

  // Upsert only the provided columns; upserting the full row would clobber a
  // concurrent partial update. On conflict, unspecified columns keep their
  // existing values; a missing row is created with column defaults.
  const payload: Record<string, unknown> = { user_id: user.id };
  if (normalized !== undefined) payload.prefs = normalized;
  if (unsubscribed_all !== undefined) payload.unsubscribed_all = unsubscribed_all;

  const { data, error } = await supabase
    .from("notification_prefs")
    .upsert(payload, { onConflict: "user_id" })
    .select("prefs, unsubscribed_all")
    .single();
  if (error) return fail("db-write", "Could not save notification preferences.", 500);

  const row = data as PrefsRow;
  return ok({
    prefs: row.prefs ?? {},
    unsubscribed_all: row.unsubscribed_all ?? false,
  });
}
