/**
 * Subscriptions — the Action Center list.
 *
 * Server wrapper: the inner client component reads ?route_error via
 * useSearchParams, which requires a Suspense boundary at the page level.
 */
import { Suspense } from "react";
import SubscriptionsList from "./SubscriptionsList";

export default function SubscriptionsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4" aria-label="Loading subscriptions">
          <div className="h-8 w-48 rounded-lg bg-[var(--skeleton)]" />
          <div className="h-32 rounded-xl bg-[var(--skeleton)]" />
          <div className="h-24 rounded-xl bg-[var(--skeleton)]" />
          <div className="h-24 rounded-xl bg-[var(--skeleton)]" />
        </div>
      }
    >
      <SubscriptionsList />
    </Suspense>
  );
}
