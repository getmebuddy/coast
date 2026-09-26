import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { deleteExpectedRefund } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * DELETE /api/routines/refunds/[id] — remove a registered expectation.
 * Signed-in only.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    try {
      await deleteExpectedRefund(viewer.userId, params.id);
      return NextResponse.json({ deleted: true }, { headers: NO_STORE });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      if (msg === "refund not found") {
        return NextResponse.json({ error: "refund not found" }, { status: 404, headers: NO_STORE });
      }
      throw e;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "refunds unavailable" }, { status: 500, headers: NO_STORE });
  }
}
