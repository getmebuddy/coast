/**
 * POST /api/notifications/push/subscribe — register this browser for web push.
 * Body: { endpoint, keys: { p256dh, auth } } (PushSubscription.toJSON()).
 * Upserts on (user_id, endpoint): re-subscribing refreshes the keys.
 *
 * DELETE /api/notifications/push/subscribe — remove this browser.
 * Body: { endpoint }.
 *
 * Session auth, 401 fail-closed. The subscription belongs to the caller's
 * user id; RLS enforces own-rows, and every write is explicitly scoped to
 * the session user as well.
 */
import { fail, getAuth, ok, readJsonBody } from "@/app/api/_lib/subscription-actions";
import { validatePushSubscription } from "@/lib/push";

export async function POST(req: Request) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { body, error: jsonError } = await readJsonBody(req);
  if (jsonError) return jsonError;

  const validated = validatePushSubscription(body);
  if (!validated.ok) {
    return fail("invalid_subscription", `Invalid push subscription: ${validated.error}.`, 400);
  }
  const { endpoint, p256dh, auth } = validated.sub;

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint,
      p256dh,
      auth,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,endpoint" }
  );
  if (error) return fail("db-write", "Could not save the push subscription.", 500);

  return ok({ subscribed: true });
}

export async function DELETE(req: Request) {
  const { supabase, user } = await getAuth();
  if (!user) return fail("unauthorized", "Sign in first.", 401);

  const { body, error: jsonError } = await readJsonBody(req);
  if (jsonError) return jsonError;

  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return fail("invalid_endpoint", "Provide the subscription endpoint to remove.", 400);
  }

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", user.id)
    .eq("endpoint", endpoint);
  if (error) return fail("db-write", "Could not remove the push subscription.", 500);

  return ok({ subscribed: false });
}
