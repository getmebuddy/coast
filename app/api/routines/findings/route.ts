import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { listOpenFindings } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/routines/findings — open findings ranked by money impact,
 * then recency. Snoozed findings return once their snooze date passes.
 * Signed-in only.
 */
export async function GET() {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    const findings = await listOpenFindings(viewer.userId);
    return NextResponse.json({ findings }, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "findings unavailable" }, { status: 500, headers: NO_STORE });
  }
}
