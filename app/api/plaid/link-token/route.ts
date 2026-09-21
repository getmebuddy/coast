import { NextResponse } from "next/server";
import { CountryCode, Products } from "plaid";
import { getPlaidClient, isPlaidConfigured } from "@/lib/plaid";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/plaid/link-token — create a Plaid Link token for the signed-in user.
 * 503 when Plaid keys aren't configured (demo mode still works).
 */
export async function POST() {
  if (!isPlaidConfigured()) {
    return NextResponse.json(
      { error: "Plaid is not configured yet. Add PLAID_CLIENT_ID / PLAID_SECRET to enable bank connection." },
      { status: 503 }
    );
  }

  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  try {
    const client = getPlaidClient();
    const resp = await client.linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: "Coast",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    return NextResponse.json({ link_token: resp.data.link_token });
  } catch (e) {
    console.error("link-token failed", e);
    return NextResponse.json(
      { error: "We couldn't start the bank connection — try again." },
      { status: 502 }
    );
  }
}
