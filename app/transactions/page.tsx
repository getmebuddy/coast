/**
 * Activity — server component.
 * Signed-out -> labeled demo (ActivityDemo + DemoBanner).
 * Signed-in  -> real ledger (ActivityReal).
 */
import ActivityDemo from "../components/ActivityDemo";
import ActivityReal from "../components/ActivityReal";
import DemoBanner from "../components/DemoBanner";
import { getViewer } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  let viewer = null;
  try {
    viewer = await getViewer();
  } catch {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Activity</h1>
        <p className="text-[var(--text-secondary)]">We couldn't verify your session. Please try again.</p>
      </div>
    );
  }

  if (!viewer) {
    return (
      <>
        <DemoBanner />
        <ActivityDemo />
      </>
    );
  }
  return <ActivityReal />;
}
