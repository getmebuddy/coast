"use client";

/**
 * Subscription detail — evidence, action choices, route preview, guided
 * flow, timeline, outcome recording, savings, and the What-If handoff.
 *
 * Honesty rules enforced here:
 *  - Opening a route sets "Action started", never "Cancelled".
 *  - Completion is only ever reported/verified — never claimed from a launch.
 *  - Unsupported merchants get the verbatim unsupported copy + a generic
 *    checklist. No fabricated URLs or phone numbers.
 *  - No merchant-password fields anywhere.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { STATUS_COPY, type ActionState } from "@/lib/subscriptions";
import { TEMP_SCENARIO_KEY } from "@/app/number/WhatIfPlanner";
import { ApiError, getJSON, patchJSON, postJSON } from "../client";
import {
  asStringList,
  billingChannelLabel,
  cadenceLabel,
  cadencePer,
  displayNameOf,
  eventLabel,
  formatDate,
  money,
  statusCopyOf,
  VERIFICATION_LABEL,
  type ActionDetailData,
  type ActionEvent,
  type HandoffResult,
  type PreviewResult,
  type SavingsRow,
  type SeriesRow,
  type SubscriptionDetailData,
  type SubscriptionItem,
} from "../types";

type OutcomeKind = "cancelled" | "paused" | "downgraded" | "kept" | "not_a_subscription";
type EvidenceChoice = "merchant_showed" | "email_received" | "none";

const OUTCOME_OPTIONS: { value: OutcomeKind; label: string }[] = [
  { value: "cancelled", label: "Cancelled" },
  { value: "paused", label: "Paused" },
  { value: "downgraded", label: "Downgraded" },
  { value: "kept", label: "Kept" },
  { value: "not_a_subscription", label: "Not a subscription" },
];

const ACTIONABLE_STATUSES = ["draft", "action_started", "needs_you", "submitted"];
const WITHDRAWABLE_STATUSES = ["draft", "action_started", "needs_you", "authorized", "submitted"];

function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dollarsToCents(text: string): number | null {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/** Representative amount: a range for variable bills, never false precision. */
function RepresentativeAmount({ series }: { series: SeriesRow }) {
  const m = series.amount_model;
  const rule = m?.rule;
  if (rule === "range" && m?.min_cents != null && m?.max_cents != null) {
    return (
      <span className="tnum">
        {money(m.min_cents)} – {money(m.max_cents)}
      </span>
    );
  }
  const single = m?.amount_cents ?? series.last_amount_cents ?? series.amount_cents_avg;
  if (rule === "median_3" && m?.min_cents != null && m?.max_cents != null) {
    return (
      <span>
        <span className="tnum">~{money(single)}</span>
        <span className="mt-1 block text-[var(--type-caption-size)] font-normal text-[var(--text-secondary)]">
          Recent charges ranged {money(m.min_cents)} – {money(m.max_cents)}
        </span>
      </span>
    );
  }
  return <span className="tnum">~{money(single)}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-[var(--type-body-size)] text-[var(--text-primary)]">{children}</dd>
    </div>
  );
}

export default function SubscriptionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [detail, setDetail] = useState<SubscriptionDetailData | null>(null);
  const [lastChargeDate, setLastChargeDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Cancel initiation
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Open action request
  const [action, setAction] = useState<ActionDetailData | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reportDone, setReportDone] = useState(false);

  // Outcome form
  const [outcomeChoice, setOutcomeChoice] = useState<OutcomeKind>("cancelled");
  const [evidenceChoice, setEvidenceChoice] = useState<EvidenceChoice>("none");
  const [evidenceDesc, setEvidenceDesc] = useState("");
  const [priorDollars, setPriorDollars] = useState("");
  const [newDollars, setNewDollars] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Series corrections
  const [patching, setPatching] = useState(false);

  // Planner handoff
  const [handoff, setHandoff] = useState<HandoffResult | null>(null);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  // Accessibility: announce status changes once, focus the status heading.
  const statusHeadingRef = useRef<HTMLHeadingElement>(null);
  const announcedRef = useRef<string | null>(null);
  const [announced, setAnnounced] = useState<string | null>(null);

  const loadAction = async (requestId: string) => {
    setActionLoading(true);
    try {
      const data = await getJSON<ActionDetailData>(`/api/actions/${requestId}`);
      setAction(data);
    } catch {
      setAction(null);
    } finally {
      setActionLoading(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [d, list] = await Promise.all([
        getJSON<SubscriptionDetailData>(`/api/subscriptions/${id}`),
        getJSON<{ items: SubscriptionItem[] }>("/api/subscriptions").catch(() => null),
      ]);
      setDetail(d);
      setLastChargeDate(
        list?.items.find((i) => i.id === id)?.last_charge_date ?? null
      );
      const open = d.open_requests?.[0];
      if (open) {
        const data = await getJSON<ActionDetailData>(`/api/actions/${open.id}`).catch(
          () => null
        );
        if (data) {
          setAction(data);
          // Guide routes need their steps even on a return visit: re-run the
          // preview to repopulate steps/version/last-verified for the panel.
          if (
            data.request.route_type !== "direct" &&
            ACTIONABLE_STATUSES.includes(data.request.status)
          ) {
            try {
              const p = await postJSON<PreviewResult>("/api/actions/preview", {
                series_id: id,
                action_type: "cancel",
              });
              setPreview(p);
            } catch {
              /* steps stay hidden; timeline and outcome recording still work */
            }
          }
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setLoadError("This subscription was not found.");
      } else {
        setLoadError(e instanceof Error ? e.message : "Could not load the subscription.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Announce status changes exactly once per change.
  useEffect(() => {
    const s = action?.request.status;
    if (s && s !== announcedRef.current) {
      announcedRef.current = s;
      setAnnounced(s);
    }
  }, [action]);

  if (loading) {
    return (
      <div className="space-y-4" aria-label="Loading subscription">
        <div className="h-8 w-44 rounded-lg bg-[var(--skeleton)]" />
        <div className="h-48 rounded-xl bg-[var(--skeleton)]" />
        <div className="h-24 rounded-xl bg-[var(--skeleton)]" />
      </div>
    );
  }

  if (loadError || !detail) {
    return (
      <div className="space-y-4">
        <Link
          href="/subscriptions"
          className="inline-flex min-h-[44px] items-center text-[var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
        >
          ← All subscriptions
        </Link>
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1" role="alert">
          <p className="text-[var(--type-body-size)] font-semibold">
            {loadError ?? "Could not load the subscription."}
          </p>
          <button
            type="button"
            onClick={load}
            className="mt-4 inline-flex min-h-[44px] items-center rounded-lg bg-[var(--surface-secondary)] px-4 font-semibold"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const series = detail.series;
  const name = displayNameOf({
    display_name: detail.registry?.display_name ?? null,
    merchant_normalized: series.merchant_normalized,
  });
  const registryName =
    detail.registry?.display_name ?? series.merchant_normalized;
  const openRequest = action?.request ?? null;
  const status = openRequest?.status ?? null;
  const actionable = status != null && ACTIONABLE_STATUSES.includes(status);
  const withdrawable = status != null && WITHDRAWABLE_STATUSES.includes(status);
  const savings: SavingsRow | null =
    action?.latest_savings ?? detail.latest_savings ?? null;
  const unsupported =
    !detail.eligibility.eligible && detail.eligibility.reason === "unsupported";

  // --- cancel initiation -------------------------------------------------
  const beginCancel = async () => {
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const p = await postJSON<PreviewResult>("/api/actions/preview", {
        series_id: id,
        action_type: "cancel",
      });
      setPreview(p);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Could not load the cancellation route.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const createRequest = async (): Promise<string | null> => {
    const { request } = await postJSON<{ request: { id: string }; deduped?: boolean }>(
      "/api/actions",
      { series_id: id, action_type: "cancel" }
    );
    return request.id;
  };

  const startDirect = async () => {
    setPreviewError(null);
    setStarting(true);
    try {
      const requestId = await createRequest();
      if (!requestId) throw new Error("Could not create the action request.");
      const { launch_url } = await postJSON<{ launch_url: string; token_expires_in: number }>(
        `/api/actions/${requestId}/launch`
      );
      // The preview panel already showed the external-navigation warning
      // before this button was reachable.
      window.open(launch_url, "_blank", "noopener,noreferrer");
      await loadAction(requestId);
      setNotice(
        "The cancellation route is open in a new tab. Tell us what happened when you are done."
      );
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Could not start the cancellation.");
    } finally {
      setStarting(false);
    }
  };

  const startGuide = async () => {
    setPreviewError(null);
    setStarting(true);
    try {
      const requestId = await createRequest();
      if (!requestId) throw new Error("Could not create the action request.");
      await loadAction(requestId);
      setPreview(null);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Could not start the guided cancellation.");
    } finally {
      setStarting(false);
    }
  };

  const relaunch = async () => {
    if (!openRequest) return;
    setPreviewError(null);
    setLaunching(true);
    try {
      const { launch_url } = await postJSON<{ launch_url: string }>(
        `/api/actions/${openRequest.id}/launch`
      );
      window.open(launch_url, "_blank", "noopener,noreferrer");
      await loadAction(openRequest.id);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Could not open the cancellation route.");
    } finally {
      setLaunching(false);
    }
  };

  // --- series corrections -------------------------------------------------
  const patchSeries = async (body: { correction?: string; lifecycle?: string }, done: string) => {
    setPatching(true);
    setNotice(null);
    try {
      await patchJSON(`/api/subscriptions/${id}`, body);
      setNotice(done);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not update the subscription.");
    } finally {
      setPatching(false);
    }
  };

  // --- outcome ------------------------------------------------------------
  const submitOutcome = async () => {
    if (!openRequest) return;
    setFormError(null);

    let priorCents: number | null = null;
    let newCents: number | null = null;
    if (outcomeChoice === "downgraded") {
      if (priorDollars.trim() || newDollars.trim()) {
        priorCents = dollarsToCents(priorDollars);
        newCents = dollarsToCents(newDollars);
        if (priorCents == null || newCents == null) {
          setFormError("Enter the old and new monthly amounts as positive numbers, or leave both blank.");
          return;
        }
        if (newCents >= priorCents) {
          setFormError("The new amount must be lower than the old amount for a downgrade.");
          return;
        }
      }
      // Both blank: the server records honest zero savings rather than guessing.
    }

    const body: Record<string, unknown> = { outcome: outcomeChoice };
    if (priorCents != null && newCents != null) {
      body.prior_amount_cents = priorCents;
      body.new_amount_cents = newCents;
    }
    const desc = evidenceDesc.trim();
    if (evidenceChoice !== "none" || desc) {
      const evidence: Record<string, unknown> = { kind: "structured" };
      if (evidenceChoice === "merchant_showed") {
        evidence.structured_value = "merchant_showed_cancelled";
      } else if (evidenceChoice === "email_received") {
        evidence.structured_value = "cancellation_email_received";
      }
      if (desc) evidence.description = desc;
      body.evidence = evidence;
    }

    setSubmitting(true);
    try {
      await postJSON(`/api/actions/${openRequest.id}/outcome`, body);
      await loadAction(openRequest.id);
      // Focus the new status heading so screen readers land on the result.
      setTimeout(() => statusHeadingRef.current?.focus(), 60);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not record the outcome.");
    } finally {
      setSubmitting(false);
    }
  };

  const withdraw = async () => {
    if (!openRequest) return;
    setWithdrawing(true);
    try {
      await postJSON(`/api/actions/${openRequest.id}/withdraw`);
      setAction(null);
      setHandoff(null);
      setNotice("The request was withdrawn. No action was sent to the merchant.");
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not withdraw the request.");
    } finally {
      setWithdrawing(false);
    }
  };

  const reportStale = async () => {
    if (!openRequest) return;
    setReporting(true);
    try {
      await postJSON(`/api/actions/${openRequest.id}/report-stale`, {
        note: reportNote.trim() || undefined,
      });
      setReportDone(true);
      setReportNote("");
      await loadAction(openRequest.id);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not file the report.");
    } finally {
      setReporting(false);
    }
  };

  // --- planner handoff ----------------------------------------------------
  const openHandoff = async () => {
    if (!openRequest) return;
    setHandoffError(null);
    setHandoffLoading(true);
    try {
      const h = await postJSON<HandoffResult>(`/api/actions/${openRequest.id}/planner`);
      setHandoff(h);
    } catch (e) {
      setHandoffError(
        e instanceof ApiError && e.error === "no_savings"
          ? "Record an outcome with savings before opening the planner."
          : e instanceof Error
            ? e.message
            : "Could not build the planner scenario."
      );
    } finally {
      setHandoffLoading(false);
    }
  };

  const exploreInPlanner = () => {
    if (!handoff) return;
    try {
      localStorage.setItem(
        TEMP_SCENARIO_KEY,
        JSON.stringify({
          monthlyInvestmentCents: handoff.handoff.scenario_monthly_investment_cents,
          label: `${name} savings`,
          note: handoff.handoff.note,
          baselineVersion: handoff.handoff.baseline_version,
          calcVersion: handoff.handoff.calc_version,
        })
      );
    } catch {
      /* storage unavailable — the planner still opens on the saved plan */
    }
    router.push("/number");
  };

  const steps = preview ? asStringList(preview.steps) : [];
  const requirements = preview ? asStringList(preview.requirements) : [];
  const warnings = preview ? asStringList(preview.warnings) : [];
  const dataShared = preview?.data_shared ?? [];

  return (
    <div className="space-y-6">
      <Link
        href="/subscriptions"
        className="inline-flex min-h-[44px] items-center text-[var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
      >
        ← All subscriptions
      </Link>

      <div>
        <h1 className="text-[var(--type-title-size)] font-bold">{name}</h1>
        <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          {billingChannelLabel(series.billing_channel)}
        </p>
      </div>

      {notice && (
        <div role="status" className="rounded-xl bg-[var(--accent-progress-soft)] p-4 elev-1">
          <p className="text-[var(--type-body-size)] text-[var(--accent-progress)]">{notice}</p>
        </div>
      )}

      {/* Single live region: announces status changes once per change. */}
      <span aria-live="polite" className="sr-only" key={announced ?? "none"}>
        {announced ? `Cancellation status: ${statusCopyOf(announced, STATUS_COPY)}` : ""}
      </span>

      {/* Evidence */}
      <section aria-label="Subscription details" className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5">
          <Field label="Typical charge">
            <span className="text-xl font-bold text-[var(--text-hero-number)]">
              <RepresentativeAmount series={series} />
            </span>
            <span className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              {" "}
              {cadencePer(series.cadence)}
            </span>
          </Field>
          <Field label="Cadence">{cadenceLabel(series.cadence)}</Field>
          <Field label="Last charged">
            <span className="tnum">{formatDate(lastChargeDate) ?? "—"}</span>
          </Field>
          <Field label="Next expected">
            <span className="tnum">
              {formatDate(series.next_expected_at ?? series.next_charge_date) ?? "—"}
            </span>
          </Field>
          <Field label="Detection confidence">
            {series.confidence != null ? (
              <span className="tnum">{Math.round(Number(series.confidence) * 100)}%</span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Price history">
            {series.price_changed && series.prev_amount_cents != null ? (
              <span className="tnum">
                <span aria-hidden="true">▲ </span>
                {money(series.prev_amount_cents)} → {money(series.last_amount_cents)}
              </span>
            ) : (
              "No recent change"
            )}
          </Field>
        </dl>
      </section>

      {/* Series decisions */}
      <section aria-label="Decide" className="space-y-3">
        {!openRequest && !unsupported && series.lifecycle_state === "active" && (
          <button
            type="button"
            onClick={beginCancel}
            disabled={previewLoading}
            aria-label={`Cancel ${name} via the best available route`}
            className="min-h-[48px] w-full rounded-lg bg-[var(--accent-progress)] font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-50"
          >
            {previewLoading ? "Checking the route…" : `Cancel ${name}`}
          </button>
        )}
        <div className="flex flex-wrap gap-2">
          {series.lifecycle_state === "active" && (
            <button
              type="button"
              onClick={() =>
                patchSeries(
                  { lifecycle: "kept" },
                  `Kept — ${name} stays. Coast will still flag price increases.`
                )
              }
              disabled={patching}
              className="min-h-[44px] flex-1 rounded-lg bg-[var(--surface-secondary)] px-4 font-semibold disabled:opacity-50"
            >
              Keep
            </button>
          )}
          {series.lifecycle_state !== "ended" && (
            <>
              <button
                type="button"
                onClick={() =>
                  patchSeries(
                    { correction: "not_subscription" },
                    "Marked as not a subscription. The detector will leave it alone."
                  )
                }
                disabled={patching}
                className="inline-flex min-h-[44px] items-center px-3 text-[var(--type-caption-size)] font-semibold text-[var(--accent-progress)] underline disabled:opacity-50"
              >
                Not a subscription
              </button>
              <button
                type="button"
                onClick={() =>
                  patchSeries(
                    { correction: "duplicate" },
                    "Marked as a duplicate series. The detector will leave it alone."
                  )
                }
                disabled={patching}
                className="inline-flex min-h-[44px] items-center px-3 text-[var(--type-caption-size)] font-semibold text-[var(--accent-progress)] underline disabled:opacity-50"
              >
                Mark duplicate
              </button>
            </>
          )}
        </div>
        {series.lifecycle_state === "kept" && (
          <p className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            <span aria-hidden="true">✓ </span>You chose to keep this subscription. Coast will still
            flag price increases.
          </p>
        )}
        {series.lifecycle_state === "ended" && (
          <p className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            <span aria-hidden="true">✕ </span>This series is ended — no further action is needed
            unless a new charge appears.
          </p>
        )}
        {series.lifecycle_state === "reopened" && (
          <p className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            <span aria-hidden="true">↻ </span>
            {STATUS_COPY.reopened}
          </p>
        )}
      </section>

      {/* Route preview */}
      {previewLoading && (
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1" aria-label="Loading route">
          <div className="h-5 w-2/3 rounded bg-[var(--skeleton)]" />
          <div className="mt-3 h-4 w-full rounded bg-[var(--skeleton)]" />
          <div className="mt-2 h-4 w-5/6 rounded bg-[var(--skeleton)]" />
        </div>
      )}

      {previewError && (
        <div role="alert" className="rounded-xl bg-[var(--signal-critical-soft)] p-4 elev-1">
          <p className="font-semibold text-[var(--signal-critical)]">{previewError}</p>
          <div className="mt-3 flex gap-2">
            {openRequest?.route_type === "direct" && (
              <button
                type="button"
                onClick={relaunch}
                disabled={launching}
                className="inline-flex min-h-[44px] items-center rounded-lg bg-[var(--surface-secondary)] px-4 font-semibold disabled:opacity-50"
              >
                Try opening the route again
              </button>
            )}
            <button
              type="button"
              onClick={() => setPreviewError(null)}
              className="inline-flex min-h-[44px] items-center rounded-lg bg-[var(--surface-secondary)] px-4 font-semibold"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {!openRequest && preview && !preview.eligible && preview.state === "unsupported" && (
        <section aria-label="Unsupported merchant" className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <h2 className="text-[var(--type-title-size)] font-bold">No verified route yet</h2>
          <p className="mt-2 text-[var(--type-body-size)]">
            {preview.copy ?? STATUS_COPY.unsupported}
          </p>
          <p className="mt-3 text-[var(--type-caption-size)] font-semibold text-[var(--text-secondary)]">
            What you can do instead:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            <li>Check your email for the original signup receipt.</li>
            <li>Look for the billing descriptor on your statement.</li>
            <li>Cancel where you subscribed — on the merchant&apos;s site or in your app-store account.</li>
          </ul>
        </section>
      )}

      {!openRequest && preview && !preview.eligible && preview.state !== "unsupported" && (
        <section aria-label="Route unavailable" className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <h2 className="text-[var(--type-title-size)] font-bold">Can&apos;t cancel through Coast</h2>
          <p className="mt-2 text-[var(--type-body-size)] text-[var(--text-secondary)]">
            {preview.reason === "action_unsupported"
              ? `Coast doesn't support cancelling ${registryName} through the Action Center.`
              : `This route isn't available right now${
                  preview.reason ? ` (${preview.reason.replace(/_/g, " ")}).` : "."
                }`}
          </p>
        </section>
      )}

      {!openRequest && preview && preview.eligible && (
        <section aria-label="Route preview" className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <h2 className="text-[var(--type-title-size)] font-bold">
            Here is how this cancellation works
          </h2>

          {preview.route_type === "assisted" ? (
            <p className="mt-2 text-[var(--type-body-size)] text-[var(--text-secondary)]">
              Assisted cancellation isn&apos;t enabled yet, so Coast can&apos;t submit this on your
              behalf. The steps below are the best available path.
            </p>
          ) : (
            <>
              {preview.destination_host && (
                <p className="mt-2 text-[var(--type-body-size)]">
                  Destination: <span className="tnum font-semibold">{preview.destination_host}</span>
                </p>
              )}

              {steps.length > 0 && (
                <div className="mt-4">
                  <p className="text-[var(--type-caption-size)] font-semibold text-[var(--text-secondary)]">
                    Expected steps
                  </p>
                  <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-[var(--type-body-size)]">
                    {steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              )}

              {dataShared.length > 0 && (
                <div className="mt-4">
                  <p className="text-[var(--type-caption-size)] font-semibold text-[var(--text-secondary)]">
                    Data shared
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                    {dataShared.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="mt-4 text-[var(--type-body-size)]">
                Fee:{" "}
                <span className="tnum font-semibold">
                  {preview.fee_cents > 0 ? money(preview.fee_cents) : "Free"}
                </span>
                {preview.fee_note && (
                  <span className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                    {" "}
                    — {preview.fee_note}
                  </span>
                )}
              </p>

              {warnings.length > 0 && (
                <div className="mt-3 rounded-lg bg-[var(--signal-warning-soft)] p-3">
                  <p className="text-[var(--type-caption-size)] font-semibold text-[var(--signal-warning)]">
                    Before you continue
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--type-caption-size)] text-[var(--signal-warning)]">
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {requirements.length > 0 && (
                <div className="mt-3">
                  <p className="text-[var(--type-caption-size)] font-semibold text-[var(--text-secondary)]">
                    You&apos;ll need
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                    {requirements.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="mt-4 text-[var(--type-micro-size)] text-[var(--text-micro)]">
                Route last verified {formatDate(preview.source_checked_at) ?? "unknown"}
                {preview.registry_version != null && ` · version ${preview.registry_version}`}
                {preview.confidence && ` · ${preview.confidence} confidence`}
              </p>

              {preview.next_status_copy && (
                <p className="mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  After you start: {preview.next_status_copy}
                </p>
              )}

              {preview.route_type === "direct" && (
                <div
                  role="note"
                  className="mt-4 rounded-lg bg-[var(--surface-secondary)] p-3 text-[var(--type-body-size)]"
                >
                  This opens {preview.destination_host ?? "the merchant's site"} in a new tab.
                  Coast cannot confirm cancellation until you return or we see evidence.
                </div>
              )}

              <button
                type="button"
                onClick={preview.route_type === "direct" ? startDirect : startGuide}
                disabled={starting || (preview.route_type === "direct" && !preview.destination_host)}
                aria-label={`Cancel ${name} via ${
                  preview.route_type === "direct" ? "account page" : "guided steps"
                }`}
                className="mt-4 min-h-[48px] w-full rounded-lg bg-[var(--accent-progress)] font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-50"
              >
                {starting
                  ? "Starting…"
                  : preview.route_type === "direct"
                    ? `Open ${preview.destination_host ?? "merchant site"} in a new tab`
                    : "Start guided cancellation"}
              </button>
            </>
          )}
        </section>
      )}

      {/* Open action request */}
      {actionLoading && (
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1" aria-label="Loading action">
          <div className="h-5 w-1/2 rounded bg-[var(--skeleton)]" />
          <div className="mt-3 h-4 w-full rounded bg-[var(--skeleton)]" />
        </div>
      )}

      {openRequest && (
        <section aria-label="Cancellation request" className="space-y-4">
          <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
            <h2
              ref={statusHeadingRef}
              tabIndex={-1}
              className="text-[var(--type-title-size)] font-bold outline-none"
            >
              {action?.next_step_copy ?? statusCopyOf(openRequest.status, STATUS_COPY)}
            </h2>
            <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              {openRequest.action_type} · {openRequest.route_type} route
              {openRequest.verification_level &&
                ` · ${VERIFICATION_LABEL[openRequest.verification_level] ?? openRequest.verification_level}`}
            </p>

            {/* Guided steps */}
            {openRequest.route_type !== "direct" && actionable && steps.length > 0 && (
              <div className="mt-4">
                <p className="text-[var(--type-caption-size)] font-semibold text-[var(--text-secondary)]">
                  Follow these steps
                </p>
                <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-[var(--type-body-size)]">
                  {steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
                <p className="mt-2 text-[var(--type-micro-size)] text-[var(--text-micro)]">
                  {preview?.registry_version != null && `Route version ${preview.registry_version} · `}
                  Last verified {formatDate(preview?.source_checked_at) ?? "unknown"}
                </p>
                {reportDone ? (
                  <p role="status" className="mt-3 text-[var(--type-caption-size)] font-semibold text-[var(--accent-progress)]">
                    Thanks — your report was filed. Coast will review this route.
                  </p>
                ) : (
                  <div className="mt-3">
                    <label
                      htmlFor="stale-note"
                      className="text-[var(--type-caption-size)] text-[var(--text-secondary)]"
                    >
                      Notice something wrong with these steps?
                    </label>
                    <input
                      id="stale-note"
                      type="text"
                      value={reportNote}
                      onChange={(e) => setReportNote(e.target.value)}
                      placeholder="Optional note"
                      maxLength={280}
                      className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 text-[var(--type-body-size)]"
                    />
                    <button
                      type="button"
                      onClick={reportStale}
                      disabled={reporting}
                      className="mt-2 inline-flex min-h-[44px] items-center rounded-lg bg-[var(--surface-secondary)] px-4 text-[var(--type-caption-size)] font-semibold disabled:opacity-50"
                    >
                      {reporting ? "Filing…" : "This no longer matches"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Re-launch a direct route still in draft */}
            {openRequest.route_type === "direct" && openRequest.status === "draft" && (
              <div className="mt-4">
                <div
                  role="note"
                  className="rounded-lg bg-[var(--surface-secondary)] p-3 text-[var(--type-body-size)]"
                >
                  This opens the merchant&apos;s cancellation page in a new tab. Coast cannot
                  confirm cancellation until you return or we see evidence.
                </div>
                <button
                  type="button"
                  onClick={relaunch}
                  disabled={launching}
                  aria-label={`Cancel ${name} via account page`}
                  className="mt-3 min-h-[48px] w-full rounded-lg bg-[var(--accent-progress)] font-semibold text-white disabled:opacity-50"
                >
                  {launching ? "Opening…" : "Open the cancellation page"}
                </button>
              </div>
            )}

            {/* Timeline */}
            {action && action.events.length > 0 && (
              <div className="mt-5">
                <p className="text-[var(--type-caption-size)] font-semibold text-[var(--text-secondary)]">
                  Timeline
                </p>
                <ol aria-label="Action timeline" className="mt-2 space-y-2">
                  {action.events.map((ev: ActionEvent) => (
                    <li key={ev.id} className="flex gap-3 text-[var(--type-body-size)]">
                      <span
                        aria-hidden="true"
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--accent-progress)]"
                      />
                      <div>
                        <p>{eventLabel(ev.event_type)}</p>
                        <p className="text-[var(--type-micro-size)] text-[var(--text-micro)]">
                          <span className="tnum">{formatDateTime(ev.occurred_at) ?? "—"}</span>
                          {" · "}
                          {ev.actor_type}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* Outcome recording */}
            {actionable && (
              <form
                className="mt-5 border-t border-[var(--border-subtle)] pt-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitOutcome();
                }}
              >
                <fieldset>
                  <legend className="text-[var(--type-body-size)] font-bold">
                    What happened?
                  </legend>
                  <div className="mt-2 space-y-1">
                    {OUTCOME_OPTIONS.map((o) => (
                      <label
                        key={o.value}
                        className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-2"
                      >
                        <input
                          type="radio"
                          name="outcome"
                          value={o.value}
                          checked={outcomeChoice === o.value}
                          onChange={() => setOutcomeChoice(o.value)}
                          className="h-5 w-5 accent-[var(--accent-progress)]"
                        />
                        <span className="text-[var(--type-body-size)]">{o.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="mt-4">
                  <legend className="text-[var(--type-caption-size)] font-semibold text-[var(--text-secondary)]">
                    Evidence <span className="font-normal">(optional)</span>
                  </legend>
                  <div className="mt-1 space-y-1">
                    {(
                      [
                        { value: "merchant_showed", label: "Merchant showed cancelled" },
                        { value: "email_received", label: "Cancellation email received" },
                        { value: "none", label: "None" },
                      ] as { value: EvidenceChoice; label: string }[]
                    ).map((e) => (
                      <label
                        key={e.value}
                        className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-2"
                      >
                        <input
                          type="radio"
                          name="evidence"
                          value={e.value}
                          checked={evidenceChoice === e.value}
                          onChange={() => setEvidenceChoice(e.value)}
                          className="h-5 w-5 accent-[var(--accent-progress)]"
                        />
                        <span className="text-[var(--type-body-size)]">{e.label}</span>
                      </label>
                    ))}
                  </div>
                  <label
                    htmlFor="evidence-desc"
                    className="mt-2 block text-[var(--type-caption-size)] text-[var(--text-secondary)]"
                  >
                    Add a note <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    id="evidence-desc"
                    type="text"
                    value={evidenceDesc}
                    onChange={(e) => setEvidenceDesc(e.target.value)}
                    placeholder="e.g. confirmation number shown on screen"
                    maxLength={280}
                    className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 text-[var(--type-body-size)]"
                  />
                </fieldset>

                {outcomeChoice === "downgraded" && (
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="prior-amount"
                        className="text-[var(--type-caption-size)] text-[var(--text-secondary)]"
                      >
                        Old monthly amount ($)
                      </label>
                      <input
                        id="prior-amount"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={priorDollars}
                        onChange={(e) => setPriorDollars(e.target.value)}
                        placeholder="Optional"
                        className="tnum mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="new-amount"
                        className="text-[var(--type-caption-size)] text-[var(--text-secondary)]"
                      >
                        New monthly amount ($)
                      </label>
                      <input
                        id="new-amount"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={newDollars}
                        onChange={(e) => setNewDollars(e.target.value)}
                        placeholder="Optional"
                        className="tnum mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3"
                      />
                    </div>
                  </div>
                )}

                {formError && (
                  <p role="alert" className="mt-3 text-[var(--type-caption-size)] font-semibold text-[var(--signal-critical)]">
                    {formError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  aria-label={`Record outcome for ${name}`}
                  className="mt-4 min-h-[48px] w-full rounded-lg bg-[var(--accent-progress)] font-semibold text-white disabled:opacity-50"
                >
                  {submitting ? "Recording…" : "Record outcome"}
                </button>
              </form>
            )}

            {withdrawable && (
              <button
                type="button"
                onClick={withdraw}
                disabled={withdrawing}
                className="mt-3 inline-flex min-h-[44px] items-center px-2 text-[var(--type-caption-size)] font-semibold text-[var(--signal-critical)] underline disabled:opacity-50"
              >
                {withdrawing ? "Withdrawing…" : "Withdraw this request"}
              </button>
            )}
          </div>

          {/* Savings */}
          {savings && (savings.monthly_cents > 0 || savings.annual_cents > 0 || savings.one_time_cents > 0 || savings.basis?.note) && (
            <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
              <h2 className="text-[var(--type-title-size)] font-bold">
                Savings — {VERIFICATION_LABEL[savings.verification] ?? savings.verification}
              </h2>
              {savings.verification === "reported" && (
                <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  Reported by you — not yet verified against your ledger.
                </p>
              )}
              <dl className="mt-3 space-y-2">
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--type-body-size)]">Monthly</dt>
                  <dd className="tnum text-[var(--type-body-size)] font-bold">
                    {money(savings.monthly_cents)}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between">
                  <dt className="text-[var(--type-body-size)]">Annual</dt>
                  <dd className="tnum text-[var(--type-body-size)] font-bold">
                    {money(savings.annual_cents)}
                  </dd>
                </div>
                {savings.one_time_cents > 0 && (
                  <div className="flex items-baseline justify-between">
                    <dt className="text-[var(--type-body-size)]">One-time refund</dt>
                    <dd className="tnum text-[var(--type-body-size)] font-bold">
                      {money(savings.one_time_cents)}
                    </dd>
                  </div>
                )}
              </dl>
              {savings.basis?.note && (
                <p className="mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  {savings.basis.note}
                </p>
              )}
              {savings.monthly_cents > 0 && (
                <button
                  type="button"
                  onClick={openHandoff}
                  disabled={handoffLoading}
                  className="mt-4 inline-flex min-h-[44px] items-center rounded-lg bg-[var(--surface-secondary)] px-4 font-semibold disabled:opacity-50"
                >
                  {handoffLoading ? "Building…" : "See what this changes"}
                </button>
              )}
              {handoffError && (
                <p role="alert" className="mt-2 text-[var(--type-caption-size)] font-semibold text-[var(--signal-critical)]">
                  {handoffError}
                </p>
              )}
            </div>
          )}

          {/* Planner handoff */}
          {handoff && (
            <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
              <h2 className="text-[var(--type-title-size)] font-bold">What this could change</h2>
              <p className="mt-2 text-[var(--type-body-size)] text-[var(--text-secondary)]">
                {handoff.handoff.note}
              </p>
              <p className="tnum mt-3 text-[var(--type-body-size)]">
                Temporary scenario: invest{" "}
                <span className="font-bold">
                  {money(handoff.handoff.scenario_monthly_investment_cents)}/mo
                </span>
              </p>
              <p className="mt-1 text-[var(--type-micro-size)] text-[var(--text-micro)]">
                Temporary only · baseline v{handoff.handoff.baseline_version} · calc{" "}
                {handoff.handoff.calc_version}
              </p>
              {handoff.baseline_note && (
                <p className="mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  {handoff.baseline_note}
                </p>
              )}
              {handoff.handoff.number_impact_available ? (
                <>
                  <button
                    type="button"
                    onClick={exploreInPlanner}
                    className="mt-4 min-h-[48px] w-full rounded-lg bg-[var(--accent-progress)] font-semibold text-white"
                  >
                    Explore in What-If planner
                  </button>
                  <p className="mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                    This opens a temporary scenario — nothing is saved. The planner&apos;s
                    &ldquo;Save as plan&rdquo; confirmation is the only way to change your plan.
                  </p>
                </>
              ) : (
                <p className="mt-3 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  These savings are cash only — the current planner can&apos;t model their
                  duration, so there&apos;s no Number impact to explore.
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
