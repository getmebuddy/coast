/**
 * Home — server component.
 * Signed-out -> labeled demo (HomeDemo + DemoBanner).
 * Signed-in  -> real dashboard (HomeReal) or honest missing/error states.
 * Auth-service failure -> explicit error, never demo.
 */
import HomeDemo from "./components/HomeDemo";
import HomeReal from "./components/HomeReal";
import DemoBanner from "./components/DemoBanner";
import { getViewer, loadHome } from "@/lib/real-data-server";

export const dynamic = "force-dynamic";

function AuthError() {
  return (
    <div className="pt-2">
      <section aria-label="Error" className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
        <p className="text-[length:var(--type-body-size)] text-[var(--text-primary)]">
          We couldn't verify your session. Please try again — your data was not touched.
        </p>
      </section>
    </div>
  );
}

export default async function Home() {
  let viewer = null;
  try {
    viewer = await getViewer();
  } catch {
    return <AuthError />;
  }

  if (!viewer) {
    return (
      <>
        <DemoBanner />
        <HomeDemo />
      </>
    );
  }

  const env = await loadHome(viewer);
  return <HomeReal initial={env} />;
}
