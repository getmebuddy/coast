import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { listRoutines, runRoutines } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function authed() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
}

function serviceError(e: unknown) {
  const msg = e instanceof Error ? e.message : "unknown";
  if (msg.startsWith("auth-service:")) {
    return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ error: "routines unavailable" }, { status: 500, headers: NO_STORE });
}

/**
 * GET /api/routines — the user's routines with on/off flags.
 * Signed-in only: 401 when signed out (fail closed, never demo).
 */
export async function GET() {
  try {
    const viewer = await getViewer();
    if (!viewer) return authed();
    const routines = await listRoutines(viewer.userId);
    return NextResponse.json({ routines }, { headers: NO_STORE });
  } catch (e) {
    return serviceError(e);
  }
}

/**
 * POST /api/routines — run every enabled routine against the ledger.
 * Idempotent: findings upsert by dedupe hash; runs are appended.
 */
export async function POST() {
  try {
    const viewer = await getViewer();
    if (!viewer) return authed();
    const summary = await runRoutines(viewer);
    return NextResponse.json({ summary }, { headers: NO_STORE });
  } catch (e) {
    return serviceError(e);
  }
}
