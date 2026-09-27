import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { deleteWatchlist } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * DELETE /api/routines/watchlists/[id] — remove a watchlist.
 * Signed-in only; RLS + user_id filter keep it to the viewer's own rows.
 */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    await deleteWatchlist(viewer.userId, params.id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "watchlists unavailable" }, { status: 500, headers: NO_STORE });
  }
}
