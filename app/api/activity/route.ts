import { NextRequest, NextResponse } from "next/server";
import { getViewer, loadActivity, type ActivityFilter } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const FILTERS = new Set(["all", "spending", "income", "transfer", "pending"]);

export async function GET(req: NextRequest) {
  try {
    const viewer = await getViewer();
    if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    const url = new URL(req.url);
    const filterParam = url.searchParams.get("filter") ?? "all";
    const filter: ActivityFilter = FILTERS.has(filterParam) ? (filterParam as ActivityFilter) : "all";
    const env = await loadActivity(viewer, {
      cursor: url.searchParams.get("cursor"),
      filter,
      q: url.searchParams.get("q") ?? "",
    });
    return NextResponse.json(env, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "failed to load activity" }, { status: 500, headers: NO_STORE });
  }
}
