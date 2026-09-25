import { NextRequest, NextResponse } from "next/server";
import { getViewer, loadBudgetMonth, loadBudgetDrilldown, saveBudgetLimits } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  try {
    const viewer = await getViewer();
    if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    const drill = new URL(req.url).searchParams.get("drilldown");
    const env = drill ? await loadBudgetDrilldown(viewer, drill.slice(0, 64)) : await loadBudgetMonth(viewer);
    return NextResponse.json(env, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "failed to load budget" }, { status: 500, headers: NO_STORE });
  }
}

interface PutBody {
  month?: string;
  /** Dollars as a number or string; parsed once, stored as integer cents. */
  ceiling?: number | string;
  categories?: Array<{ category: string; limit: number | string }>;
}

function toCents(v: number | string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n) || n < 0) throw new Error("invalid amount");
  return Math.round(n * 100);
}

export async function PUT(req: NextRequest) {
  try {
    const viewer = await getViewer();
    if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    const body = (await req.json()) as PutBody;
    if (!body || typeof body.month !== "string") {
      return NextResponse.json({ error: "month is required (YYYY-MM-01)" }, { status: 400, headers: NO_STORE });
    }
    const env = await saveBudgetLimits(viewer, {
      month: body.month,
      ceilingCents: body.ceiling !== undefined ? toCents(body.ceiling) : undefined,
      categories: (body.categories ?? []).map((c) => ({
        category: String(c.category ?? "").slice(0, 64),
        limitCents: toCents(c.limit),
      })),
    });
    if (env.mode === "error") {
      return NextResponse.json({ error: "failed to save budget" }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(env, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.startsWith("auth-service:")) {
      return NextResponse.json({ error: "auth service unavailable" }, { status: 503, headers: NO_STORE });
    }
    if (msg === "invalid amount" || msg === "invalid category" || msg === "nothing to save" || msg.startsWith("limit_cents")) {
      return NextResponse.json({ error: msg }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ error: "failed to save budget" }, { status: 500, headers: NO_STORE });
  }
}
