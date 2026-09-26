import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { setRoutineEnabled } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PATCH /api/routines/[key] — toggle a routine on/off.
 * Body: { enabled: boolean }. Signed-in only.
 */
export async function PATCH(
  req: Request,
  { params }: { params: { key: string } }
) {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    let body: { enabled?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
    }
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400, headers: NO_STORE });
    }
    try {
      const routine = await setRoutineEnabled(viewer.userId, params.key, body.enabled);
      return NextResponse.json({ routine }, { headers: NO_STORE });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      if (msg === "unknown routine") {
        return NextResponse.json({ error: "unknown routine" }, { status: 404, headers: NO_STORE });
      }
      throw e;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "routines unavailable" }, { status: 500, headers: NO_STORE });
  }
}
