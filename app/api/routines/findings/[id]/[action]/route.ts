import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { actOnFinding, type FindingAction } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const ACTIONS: FindingAction[] = ["resolve", "dismiss", "snooze"];

/**
 * POST /api/routines/findings/[id]/[action] — resolve, dismiss, or snooze.
 * Snooze body: { days?: number } (1-90, default 7). Signed-in only.
 * Resolving is the user saying "handled"; dismissing says "not for me".
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string; action: string } }
) {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    if (!ACTIONS.includes(params.action as FindingAction)) {
      return NextResponse.json({ error: "unknown action" }, { status: 404, headers: NO_STORE });
    }
    let days = 7;
    try {
      const body = await req.json();
      if (typeof body?.days === "number") days = body.days;
    } catch {
      // empty body is fine; default snooze applies
    }
    try {
      const finding = await actOnFinding(
        viewer.userId,
        params.id,
        params.action as FindingAction,
        days
      );
      return NextResponse.json({ finding }, { headers: NO_STORE });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      if (msg === "finding not found") {
        return NextResponse.json({ error: "finding not found" }, { status: 404, headers: NO_STORE });
      }
      throw e;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "findings unavailable" }, { status: 500, headers: NO_STORE });
  }
}
