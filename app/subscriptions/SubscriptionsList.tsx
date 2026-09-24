"use client";

/**
 * Subscription Action Center — list.
 *
 * Hero: total recurring monthly, active count, price-increase amount.
 * Action queue (open action_requests needing the user) renders FIRST,
 * then discovery cards. Negotiation ("Lower this bill") is intentionally
 * absent: the pilot is out of scope and the feature flag is off.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { STATUS_COPY, type ActionState } from "@/lib/subscriptions";
import { ApiError, getJSON } from "./client";
import {
  cadencePer,
  displayNameOf,
  money,
  statusCopyOf,
  type ActionRequestSummary,
  type SubscriptionDetailData,
  type SubscriptionItem,
} from "./types";

const ROUTE_ERROR_COPY: Record<string, string> = {
  expired: "That cancellation link expired.",
  invalid: "That cancellation link was invalid.",
  revoked: "That cancellation route was disabled.",
};

interface QueueEntry {
  item: SubscriptionItem;
  request: ActionRequestSummary;
}

function lifecycleBadge(state: string): { glyph: string; text: string } | null {
  switch (state) {
    case "reopened":
      return { glyph: "↻", text: "Possible renewal" };
    case "kept":
      return { glyph: "✓", text: "Kept" };
    case "ended":
      return { glyph: "✕", text: "Ended" };
    default:
      return null;
  }
}

function Badge({ glyph, text, tone }: { glyph: string; text: string; tone: "warn" | "muted" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--type-micro-size)] font-semibold ${
        tone === "warn"
          ? "bg-[var(--signal-warning-soft)] text-[var(--signal-warning)]"
          : "bg-[var(--surface-secondary)] text-[var(--text-secondary)]"
      }`}
    >
      <span aria-hidden="true">{glyph}</span>
      {text}
    </span>
  );
}

export default function SubscriptionsList() {
  const searchParams = useSearchParams();
  const routeError = searchParams.get("route_error");

  const [items, setItems] = useState<SubscriptionItem[] | null>(null);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setQueue([]);
    setError(null);
    setUnauthorized(false);
    (async () => {
      try {
        const { items: list } = await getJSON<{ items: SubscriptionItem[] }>(
          "/api/subscriptions"
        );
        if (cancelled) return;
        setItems(list);
        // Per-item open requests power the action queue. Failures are
        // tolerated per item — the discovery card still renders.
        const settled = await Promise.allSettled(
          list.map((i) => getJSON<SubscriptionDetailData>(`/api/subscriptions/${i.id}`))
        );
        if (cancelled) return;
        const q: QueueEntry[] = [];
        settled.forEach((r, idx) => {
          if (r.status === "fulfilled") {
            for (const req of r.value.open_requests ?? []) {
              q.push({ item: list[idx], request: req });
            }
          }
        });
        setQueue(q);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          setUnauthorized(true);
        } else {
          setError(e instanceof Error ? e.message : "Could not load subscriptions.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [retryNonce]);

  const { activeItems, totalMonthly, priceUpMonthly, queuedIds } = useMemo(() => {
    const active = (items ?? []).filter((i) => i.lifecycle_state === "active");
    const total = active.reduce((s, i) => s + (i.monthly_cents || 0), 0);
    const priceUp = active
      .filter((i) => i.price_changed)
      .reduce((s, i) => s + (i.monthly_cents || 0), 0);
    return {
      activeItems: active,
      totalMonthly: total,
      priceUpMonthly: priceUp,
      queuedIds: new Set(queue.map((q) => q.item.id)),
    };
  }, [items, queue]);

  const discovery = useMemo(
    () => (items ?? []).filter((i) => !queuedIds.has(i.id)),
    [items, queuedIds]
  );

  const routeErrorCopy =
    routeError != null ? ROUTE_ERROR_COPY[routeError] : undefined;

  if (unauthorized) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Subscriptions</h1>
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <p className="text-[length:var(--type-body-size)]">Sign in to see your subscriptions.</p>
          <Link
            href="/login?next=/subscriptions"
            className="mt-4 inline-flex min-h-[44px] items-center rounded-lg bg-[var(--accent-progress)] px-4 font-semibold text-white"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Subscriptions</h1>
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1" role="alert">
          <p className="text-[length:var(--type-body-size)] font-semibold">Couldn&apos;t load subscriptions.</p>
          <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">{error}</p>
          <button
            type="button"
            onClick={() => setRetryNonce((n) => n + 1)}
            className="mt-4 inline-flex min-h-[44px] items-center rounded-lg bg-[var(--surface-secondary)] px-4 font-semibold"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (items === null) {
    // Static blocks (no shimmer) — reduced-motion safe by construction.
    return (
      <div className="space-y-4" aria-label="Loading subscriptions">
        <div className="h-8 w-44 rounded-lg bg-[var(--skeleton)]" />
        <div className="h-36 rounded-xl bg-[var(--skeleton)]" />
        <div className="h-24 rounded-xl bg-[var(--skeleton)]" />
        <div className="h-24 rounded-xl bg-[var(--skeleton)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--type-title-size)] font-bold">Subscriptions</h1>
        <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Every recurring charge Coast found — and what to do about it.
        </p>
      </div>

      {routeErrorCopy && (
        <div
          role="alert"
          className="rounded-xl bg-[var(--signal-warning-soft)] p-4 text-[length:var(--type-body-size)] text-[var(--signal-warning)] elev-1"
        >
          <p className="font-semibold">{routeErrorCopy}</p>
          <p className="mt-1 text-[length:var(--type-caption-size)]">No action was taken.</p>
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <p className="text-[length:var(--type-body-size)] font-semibold">No subscriptions found yet.</p>
          <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            Coast watches your connected accounts for recurring charges. Once it spots a pattern,
            it will appear here with a cancel path.
          </p>
        </div>
      ) : (
        <>
          {/* Hero */}
          <section
            aria-label="Recurring totals"
            className="rounded-xl bg-[var(--surface-card)] p-6 elev-1"
          >
            <p className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
              Recurring each month
            </p>
            <p className="tnum mt-1 text-3xl font-bold text-[var(--text-hero-number)]">
              {money(totalMonthly)}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              <span>
                <span className="tnum font-semibold text-[var(--text-primary)]">
                  {activeItems.length}
                </span>{" "}
                active {activeItems.length === 1 ? "subscription" : "subscriptions"}
              </span>
              {priceUpMonthly > 0 && (
                <span>
                  <span aria-hidden="true">▲ </span>
                  <span className="tnum font-semibold text-[var(--signal-warning)]">
                    {money(priceUpMonthly)}
                  </span>{" "}
                  with a recent price increase
                </span>
              )}
            </div>
          </section>

          {/* Action queue — open requests needing the user come FIRST */}
          {queue.length > 0 && (
            <section aria-label="Action queue" className="space-y-3">
              <h2 className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
                Needs your attention
              </h2>
              <ul className="space-y-3">
                {queue.map(({ item, request }) => {
                  const name = displayNameOf(item);
                  return (
                    <li
                      key={request.id}
                      className="rounded-xl bg-[var(--surface-card)] p-4 elev-1"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[length:var(--type-body-size)] font-semibold">
                            {name}
                          </p>
                          <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                            {statusCopyOf(request.status, STATUS_COPY)}
                          </p>
                        </div>
                        <Link
                          href={`/subscriptions/${item.id}`}
                          aria-label={`Continue ${request.action_type} for ${name}`}
                          className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg bg-[var(--accent-progress)] px-4 font-semibold text-white"
                        >
                          Continue
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Discovery cards */}
          <section aria-label="All subscriptions" className="space-y-3">
            {queue.length > 0 && (
              <h2 className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
                All subscriptions
              </h2>
            )}
            <ul className="space-y-3">
              {discovery.map((item) => {
                const name = displayNameOf(item);
                const badge = lifecycleBadge(item.lifecycle_state);
                const active = item.lifecycle_state === "active";
                return (
                  <li
                    key={item.id}
                    className="rounded-xl bg-[var(--surface-card)] p-4 elev-1"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[length:var(--type-body-size)] font-semibold">
                          {name}
                        </p>
                        <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                          <span className="tnum font-semibold text-[var(--text-primary)]">
                            ~{money(item.monthly_cents)}
                            {cadencePer(item.cadence)}
                          </span>
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.price_changed && (
                            <Badge glyph="▲" text="Price up" tone="warn" />
                          )}
                          {badge && <Badge glyph={badge.glyph} text={badge.text} tone="muted" />}
                        </div>
                      </div>
                      <Link
                        href={`/subscriptions/${item.id}`}
                        aria-label={active ? `Cancel ${name}` : `Review ${name}`}
                        className={`inline-flex min-h-[44px] shrink-0 items-center rounded-lg px-4 font-semibold ${
                          active
                            ? "bg-[var(--accent-progress)] text-white"
                            : "bg-[var(--surface-secondary)] text-[var(--text-primary)]"
                        }`}
                      >
                        {active ? "Cancel" : "Review"}
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Negotiation is out of scope for this release: the pilot flag is
              off and assisted/negotiate routes are disabled, so no
              "Lower this bill" button is rendered here. */}
        </>
      )}
    </div>
  );
}
