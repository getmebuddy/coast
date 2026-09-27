import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { addWatchlist, listWatchlists } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/routines/watchlists — the viewer's watchlists, newest first.
 * POST /api/routines/watchlists — add one.
 * Body: { name: string, target_kind: "merchant" | "category", target: string,
 *         threshold_dollars: number | string }.
 * Signed-in only.
 */
export async function GET() {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    const watchlists = await listWatchlists(viewer.userId);
    return NextResponse.json({ watchlists }, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "watchlists unavailable" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    let body: {
      name?: unknown;
      target_kind?: unknown;
      target?: unknown;
      threshold_dollars?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
    }
    const dollars =
      typeof body.threshold_dollars === "string" ? Number(body.threshold_dollars) : body.threshold_dollars;
    if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0) {
      return NextResponse.json({ error: "threshold must be a positive dollar amount" }, { status: 400, headers: NO_STORE });
    }
    try {
      const watchlist = await addWatchlist(viewer.userId, {
        name: String(body.name ?? ""),
        target_kind: body.target_kind === "category" ? "category" : "merchant",
        target: String(body.target ?? ""),
        threshold_cents: Math.round(dollars * 100),
      });
      return NextResponse.json({ watchlist }, { status: 201, headers: NO_STORE });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      if (msg.startsWith("watchlist-invalid:")) {
        return NextResponse.json({ error: msg }, { status: 400, headers: NO_STORE });
      }
      throw e;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "watchlists unavailable" }, { status: 500, headers: NO_STORE });
  }
}
