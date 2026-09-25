/**
 * Budgets — server component.
 * Signed-out -> labeled demo (BudgetsDemo + DemoBanner).
 * Signed-in  -> real budget (BudgetsReal).
 */
import BudgetsDemo from "../components/BudgetsDemo";
import BudgetsReal from "../components/BudgetsReal";
import DemoBanner from "../components/DemoBanner";
import { getViewer } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  let viewer = null;
  try {
    viewer = await getViewer();
  } catch {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Budgets</h1>
        <p className="text-[var(--text-secondary)]">We couldn't verify your session. Please try again.</p>
      </div>
    );
  }

  if (!viewer) {
    return (
      <>
        <DemoBanner />
        <BudgetsDemo />
      </>
    );
  }
  return <BudgetsReal />;
}
