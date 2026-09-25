import { NextResponse } from "next/server";
import { buildBrief } from "@/lib/brief";
import { getViewer, loadRealBrief } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/brief — the morning brief.
 * Signed-out  -> labeled demo brief (mode "demo", demo: true). Never tracked.
 * Signed-in   -> real brief assembled from the user's ledger. Fail closed:
 *                any assembly failure returns an explicit error, never demo.
 * The read timestamp advances only after successful assembly, and the
 * morning_brief_viewed event is logged server-side with the mode label.
 */
export async function GET() {
  const now = new Date();
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json(
        {
          mode: "demo",
          demo: true,
          as_of: now.toISOString(),
          timezone: "America/Chicago",
          provenance: { brief: "demo" },
          data: { brief: buildBrief(now), missing: [] },
          missing: [],
        },
        { headers: NO_STORE }
      );
    }
    const env = await loadRealBrief(viewer, now);
    return NextResponse.json(env, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "brief unavailable" }, { status: 500, headers: NO_STORE });
  }
}
