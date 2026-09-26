import { NextResponse } from "next/server";
import { getViewer } from "@/lib/real-data-server";
import { createExpectedRefund, listExpectedRefunds } from "@/lib/routines-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/routines/refunds — expected refunds and their statuses.
 * POST /api/routines/refunds — register one: "I returned this".
 * Body: { merchant: string, amount_cents: integer > 0, expected_date: YYYY-MM-DD }.
 * Signed-in only.
 */
export async function GET() {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    const refunds = await listExpectedRefunds(viewer.userId);
    return NextResponse.json({ refunds }, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "refunds unavailable" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    }
    let body: { merchant?: unknown; amount_cents?: unknown; expected_date?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
    }
    try {
      const refund = await createExpectedRefund(viewer.userId, {
        merchant: String(body.merchant ?? ""),
        amount_cents: Number(body.amount_cents),
        expected_date: String(body.expected_date ?? ""),
      });
      return NextResponse.json({ refund }, { status: 201, headers: NO_STORE });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      if (msg.startsWith("invalid ")) {
        return NextResponse.json({ error: msg }, { status: 400, headers: NO_STORE });
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
