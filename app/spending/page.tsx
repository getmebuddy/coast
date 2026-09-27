/**
 * Spending tab — the explorer.
 * Signed-out -> labeled demo. Signed-in -> real ledger or honest states.
 */
import SpendingDemo from "../components/SpendingDemo";
import SpendingReal from "../components/SpendingReal";
import DemoBanner from "../components/DemoBanner";
import { getViewer } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

export default async function SpendingPage() {
  let viewer = null;
  try {
    viewer = await getViewer();
  } catch {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Spending</h1>
        <p className="text-[var(--text-secondary)]">We couldn't verify your session. Please try again.</p>
      </div>
    );
  }

  if (!viewer) {
    return (
      <>
        <DemoBanner />
        <SpendingDemo />
      </>
    );
  }
  return <SpendingReal />;
}
