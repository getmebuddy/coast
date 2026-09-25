/**
 * Server-side pilot event logging.
 *
 * SERVER ONLY — never import into client components (uses the service-role
 * key). Route handlers call logPilotEvent() after the primary write
 * succeeds. Logging is best-effort and non-fatal: analytics must never
 * break auth, Plaid, or saves.
 */
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  validatePilotEvent,
  type PilotEventName,
} from "@/lib/analytics";

/** Pilot cohort stamped on server-logged events. */
export const PILOT_COHORT = "founding-2026-09";

export async function logPilotEvent(
  userId: string,
  name: PilotEventName,
  props?: Record<string, string>,
  opts?: { cohort?: string; acquisitionChannel?: string }
): Promise<void> {
  try {
    const { props: clean } = validatePilotEvent(name, props);
    const db = createServiceSupabase();
    const { error } = await db.from("pilot_events").insert({
      user_id: userId,
      event_name: name,
      properties: clean,
      cohort: opts?.cohort ?? PILOT_COHORT,
      acquisition_channel: opts?.acquisitionChannel ?? null,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[pilot-analytics] insert failed (non-fatal)", error.code, name);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[pilot-analytics] log failed (non-fatal)", e);
  }
}
