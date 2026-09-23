import { NextResponse } from "next/server";
import { encryptAccessToken, getPlaidClient, isPlaidConfigured } from "@/lib/plaid";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";

/**
 * POST /api/plaid/exchange — swap a Plaid public_token for an access token
 * and store the connection. The access token is encrypted at rest and
 * NEVER returned to the client.
 */

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
    const db = createServiceSupabase();
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
    return NextResponse.json({ item });
  } catch (e) {
    console.error(`exchange failed at ${stage}`, e);
    return NextResponse.json(
      { error: "We couldn't finish connecting — your data is safe, try again.", stage },
      { status: 502 }
    );
  }
}
