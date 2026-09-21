import { NextResponse } from "next/server";
import { buildBrief } from "@/lib/brief";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * GET /api/brief — the morning brief, computed from the ledger.
 * v1: computed from the demo ledger for every visitor (demo mode first).
 * When signed in, marks the brief as read server-side (brief_reads).
 */
export async function GET() {
  const brief = buildBrief(new Date());

  try {
    const supabase = createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("brief_reads").upsert(
        { user_id: user.id, last_read_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
    }
  } catch {
    // Read-state persistence is best-effort; never fail the brief for it.
  }

  return NextResponse.json(brief, {
    headers: { "Cache-Control": "no-store" },
  });
}
