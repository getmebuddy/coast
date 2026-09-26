import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { listRuns } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/routines/runs — the transparency log: every routine run,
 * what it checked, and what it found. Signed-in only.
 */
export async function GET() {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    const runs = await listRuns(viewer.userId);
    return NextResponse.json({ runs }, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "runs unavailable" }, { status: 500, headers: NO_STORE });
  }
}
