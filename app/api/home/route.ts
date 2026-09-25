import { NextResponse } from "next/server";
import { getViewer, loadHome } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const viewer = await getViewer();
    if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    const env = await loadHome(viewer);
    return NextResponse.json(env, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "failed to load dashboard" }, { status: 500, headers: NO_STORE });
  }
}
