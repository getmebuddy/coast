import { NextResponse } from "next/server";
import { getViewer, loadSpending, loadSpendingBucket } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/spending — spending explorer data for the signed-in viewer.
 * All four ranges precomputed; finish-line pace included when the user has
 * FIRE settings. Signed-in only; 401 for anonymous visitors.
 *
 * GET /api/spending?bucket=<key> — category drill-down (with top
 * transactions) for one historical bucket, e.g. ?bucket=2026-08. 404 when
 * the key matches no bucket. Same auth and provenance rules.
 */
export async function GET(req: Request) {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    const bucketKey = new URL(req.url).searchParams.get("bucket");
    if (bucketKey) {
      const env = await loadSpendingBucket(viewer, bucketKey);
      if (!env) {
        return NextResponse.json({ error: "bucket not found" }, { status: 404, headers: NO_STORE });
      }
      return NextResponse.json(env, { headers: NO_STORE });
    }
    const env = await loadSpending(viewer);
    return NextResponse.json(env, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "spending unavailable" }, { status: 500, headers: NO_STORE });
  }
}
