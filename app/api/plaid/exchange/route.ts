import { NextResponse } from "next/server";
import { encryptAccessToken, getPlaidClient, isPlaidConfigured } from "@/lib/plaid";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { logPilotEvent } from "@/lib/analytics-server";

/**
 * POST /api/plaid/exchange — swap a Plaid public_token for an access token
 * and store the connection. The access token is encrypted at rest and
 * NEVER returned to the client.
 */

/**
 * Short, safe diagnostic fragment for the client-facing error code.
 * Carries the PostgREST code + a sanitized message so a failed retry can be
 * diagnosed without another round-trip. Never includes request payloads —
 * the access token stays server-side.
 */
function diagnosticDetail(e: unknown): string {
  const parts: string[] = [];
  if (typeof e === "object" && e !== null) {
    const rec = e as Record<string, unknown>;
    if (typeof rec.code === "string" && rec.code) parts.push(rec.code);
  }
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e !== null && "message" in e
        ? String((e as Record<string, unknown>).message)
        : String(e);
  const clean = msg
    .replace(/[^a-zA-Z0-9 _\-.]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64);
  if (clean) parts.push(clean);
  return parts.join("-");
}

export async function POST(req: Request) {
  if (!isPlaidConfigured()) {
    return NextResponse.json({ error: "Plaid is not configured yet." }, { status: 503 });
  }

  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first.", stage: "auth" }, { status: 401 });

  let body: { public_token?: string; institution_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!body.public_token) return NextResponse.json({ error: "Missing public_token." }, { status: 400 });

  let stage = "token-exchange";
  try {
    const client = getPlaidClient();
    const exchange = await client.itemPublicTokenExchange({ public_token: body.public_token });
    const accessToken = exchange.data.access_token;

    // Best-effort: the item id is only a display-name fallback.
    stage = "item-get";
    let institutionName = body.institution_name ?? "Your bank";
    try {
      const itemGet = await client.itemGet({ access_token: accessToken });
      institutionName = body.institution_name ?? itemGet.data.item.institution_id ?? "Your bank";
    } catch (e) {
      console.warn("itemGet failed, continuing with fallback name", e);
    }

    stage = "db-insert";
    // Service-role client: SELECT on plaid_items is revoked for
    // anon/authenticated by design (the token column must never be
    // client-readable), so INSERT ... RETURNING via the session client
    // fails with "permission denied". Auth was already verified above.
    // Fail loudly if the key isn't configured — the deployment needs
    // SUPABASE_SERVICE_ROLE_KEY in its env vars (and a redeploy after adding).
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("service-key-missing");
    }
    const db = createServiceSupabase();
    // Backstop: every user_id column references profiles(id), which the
    // on_auth_user_created trigger normally creates at sign-up. Ensure it
    // here so a missing profile can never fail the connect with a 23503.
    const { error: profileError } = await db
      .from("profiles")
      .upsert({ id: user.id }, { onConflict: "id", ignoreDuplicates: true });
    if (profileError) throw profileError;

    const { data: item, error } = await db
      .from("plaid_items")
      .insert({
        user_id: user.id,
        access_token_encrypted: encryptAccessToken(accessToken),
        institution_name: institutionName,
        cursor: null,
        status: "active",
      })
      .select("id, institution_name, status, created_at")
      .single();

    if (error) throw error;
    // Pilot analytics: link succeeded. Non-fatal, after the real write.
    await logPilotEvent(user.id, "account_link_succeeded", {});
    return NextResponse.json({ item });
  } catch (e) {
    // The client renders this as [exchange:502/<stage>[:<detail>]] — the
    // detail names the actual failure (e.g. service-key-missing,
    // 42501-permission-denied) so the next retry is diagnosable on sight.
    const detail = diagnosticDetail(e);
    const stageLabel = detail ? `${stage}:${detail}` : stage;
    console.error(`exchange failed at ${stage}`, e);
    // Pilot analytics: link failed with the stage bucket. Best-effort —
    // user may be null only if auth failed, in which case skip.
    try {
      const supabase = createServerSupabase();
      const {
        data: { user: failedUser },
      } = await supabase.auth.getUser();
      if (failedUser) {
        await logPilotEvent(failedUser.id, "account_link_failed", { stage });
      }
    } catch {
      /* ignore */
    }
    return NextResponse.json(
      { error: "We couldn't finish connecting — your data is safe, try again.", stage: stageLabel },
      { status: 502 }
    );
  }
}
