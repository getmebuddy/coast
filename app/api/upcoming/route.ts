import { NextResponse } from "next/server";
import { getViewer, loadUpcoming } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/upcoming — next 14 days of expected recurring charges plus the
 * next expected payday (inferred from the ledger's recurring income
 * pattern, when one exists). Read-only. Signed-in only; 401 anonymous.
 */
export async function GET() {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    const env = await loadUpcoming(viewer);
    return NextResponse.json(env, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "upcoming unavailable" }, { status: 500, headers: NO_STORE });
  }
}
