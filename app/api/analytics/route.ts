import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import {
  validatePilotEvent,
  isValidPilotCohort,
} from "@/lib/analytics";
import { PILOT_COHORT } from "@/lib/analytics-server";

/**
 * POST /api/analytics — client-side pilot event ingestion.
 *
 * Body: { event: PilotEventName, properties?: Record<string,string>,
 *         cohort?: string, acquisition_channel?: string }
 * Auth comes from the session cookie; the client never sends a user id.
 * Events are validated (allowlist + prop denylist) and written with the
 * service-role client. RLS on pilot_events has no user policies by design.
 */

export async function POST(req: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    event?: unknown;
    properties?: unknown;
    cohort?: unknown;
    acquisition_channel?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }

  let name: string;
  let props: Record<string, string>;
  try {
    if (typeof body.event !== "string") throw new Error("bad-event");
    const p =
      body.properties === undefined
        ? {}
        : (body.properties as Record<string, unknown>);
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error("bad-props");
    const strProps: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) {
      if (typeof v !== "string") throw new Error("bad-props");
      strProps[k] = v;
    }
    ({ name, props } = validatePilotEvent(body.event, strProps) as {
      name: string;
      props: Record<string, string>;
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "bad-event" },
      { status: 400 }
    );
  }

  const cohort =
    typeof body.cohort === "string" && isValidPilotCohort(body.cohort)
      ? body.cohort
      : PILOT_COHORT;
  const channel =
    typeof body.acquisition_channel === "string" &&
    isValidPilotCohort(body.acquisition_channel)
      ? body.acquisition_channel
      : null;

  const db = createServiceSupabase();
  const { error } = await db.from("pilot_events").insert({
    user_id: user.id,
    event_name: name,
    properties: props,
    cohort,
    acquisition_channel: channel,
  });
  if (error) {
    console.error("[pilot-analytics] api insert failed", error.code);
    return NextResponse.json({ error: "write-failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
