"use client";

/**
 * What-If Planner — baseline-vs-scenario FIRE planning.
 *
 * The saved plan is sacred: dragging controls only mutates an in-memory
 * draft. Nothing persists until the user confirms "Save as plan".
 * Projections are deterministic educational illustrations, not advice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CALCULATION_VERSION,
  PRESETS,
  RANGES,
  actionSentence,
  arrivalMonthLabel,
  assessFeasibility,
  clampInput,
  deltaBucket,
  deltaMonths,
  diffInputs,
  formatDelta,
  gapBucket,
  projectWhatIf,
  resolveSaveInputs,
  resolveTargetCents,
  shareText,
  validateInputs,
  type InputKey,
  type WhatIfInputs,
} from "@/lib/whatif";
import { trackPlannerEvent } from "@/lib/analytics";
import { formatUSD, formatUSDCompact, monthYear, progressPct } from "@/lib/fire";
import TrajectoryRing from "../components/TrajectoryRing";
export type PlannerMode = "saved" | "setup" | "demo";

export interface PlannerInitial {
  baseline: WhatIfInputs;
  settingsVersion: number;
  savedAt: string | null;
  mode: PlannerMode;
  observedSurplusCents: number | null;
}

const DRAFT_KEY = "coast-whatif-draft-v1";
const dollarsToCents = (d: number) => Math.round(d * 100);

/**
 * Subscription Action Center handoff: a temporary scenario written by the
 * subscriptions detail page before navigating to /number. Applies on mount
 * only, is labeled TEMPORARY, is never persisted as a draft, and never
 * touches the saved plan — the existing "Save as plan" confirmation stays
 * the only gate to persistence.
 */
export const TEMP_SCENARIO_KEY = "coast-whatif-temp-scenario-v1";

export interface TempScenario {
  monthlyInvestmentCents: number;
  label: string;
  note: string;
  baselineVersion: string;
  calcVersion: string;
}

function loadTempScenario(): TempScenario | null {
  try {
    const raw = localStorage.getItem(TEMP_SCENARIO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TempScenario>;
    if (typeof parsed.monthlyInvestmentCents !== "number") return null;
    return {
      monthlyInvestmentCents: parsed.monthlyInvestmentCents,
      label: typeof parsed.label === "string" ? parsed.label : "Subscription savings",
      note: typeof parsed.note === "string" ? parsed.note : "",
      baselineVersion: typeof parsed.baselineVersion === "string" ? parsed.baselineVersion : "",
      calcVersion: typeof parsed.calcVersion === "string" ? parsed.calcVersion : "",
    };
  } catch {
    return null;
  }
}

function loadStoredDraft(): WhatIfInputs | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WhatIfInputs;
    return validateInputs(parsed).length === 0 ? parsed : null;
  } catch {
    return null;
  }
}

function sameInputs(a: WhatIfInputs, b: WhatIfInputs): boolean {
  return (
    a.monthlySpendingCents === b.monthlySpendingCents &&
    a.portfolioCents === b.portfolioCents &&
    a.monthlyInvestmentCents === b.monthlyInvestmentCents &&
    a.annualReturnPct === b.annualReturnPct &&
    a.targetMode === b.targetMode &&
    a.customTargetCents === b.customTargetCents &&
    a.investDifference === b.investDifference
  );
}

/** Slider + stepper + direct numeric entry. Dollars shown, cents stored. */
function MoneyControl({
  id,
  label,
  valueCents,
  inputKey,
  onChange,
  format,
}: {
  id: string;
  label: string;
  valueCents: number;
  inputKey: InputKey;
  onChange: (cents: number) => void;
  format: (cents: number) => string;
}) {
  const r = RANGES[inputKey];
  const [text, setText] = useState<string | null>(null);
  const commit = (dollars: number) => {
    if (Number.isFinite(dollars)) onChange(clampInput(inputKey, dollarsToCents(dollars)));
    setText(null);
  };
  const descId = `${id}-desc`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          {label}
        </label>
        <span className="tnum text-[var(--type-body-size)] font-semibold">{format(valueCents)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="whatif mt-1 w-full"
        aria-describedby={descId}
        aria-valuetext={format(valueCents)}
        min={r.min}
        max={r.max}
        step={r.step}
        value={valueCents}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(clampInput(inputKey, valueCents - r.step))}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg bg-[var(--surface-secondary)] text-xl font-semibold"
        >
          −
        </button>
        <input
          type="number"
          inputMode="decimal"
          aria-label={`${label} in dollars`}
          value={text ?? String(Math.round(valueCents / 100))}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(Number((e.target as HTMLInputElement).value));
          }}
          className="tnum min-h-[44px] w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 text-center"
        />
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(clampInput(inputKey, valueCents + r.step))}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg bg-[var(--surface-secondary)] text-xl font-semibold"
        >
          +
        </button>
      </div>
      <p id={descId} className="sr-only">
        {label}: {format(r.min)} to {format(r.max)}, in steps of {format(r.step)}.
      </p>
    </div>
  );
}

export default function WhatIfPlanner({ initial }: { initial: PlannerInitial }) {
  const router = useRouter();
  const [baseline, setBaseline] = useState<WhatIfInputs>(initial.baseline);
  const [settingsVersion, setSettingsVersion] = useState(initial.settingsVersion);
  const [savedAt, setSavedAt] = useState(initial.savedAt);
  const [mode, setMode] = useState<PlannerMode>(initial.mode);
  const [draft, setDraft] = useState<WhatIfInputs>(initial.baseline);
  const [setupStarted, setSetupStarted] = useState(initial.mode !== "setup");
  const [restoreOffer, setRestoreOffer] = useState<WhatIfInputs | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scenarioName, setScenarioName] = useState("");
  const [ackFeas, setAckFeas] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WhatIfInputs | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [shared, setShared] = useState(false);
  const [tempScenario, setTempScenario] = useState<TempScenario | null>(null);

  const heroRef = useRef<HTMLHeadingElement>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const completedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feasSeen = useRef(false);

  // ---------- projections (pure, instant, no network) ----------
  const baseProj = useMemo(() => projectWhatIf(baseline, baseline), [baseline]);
  const scenProj = useMemo(() => projectWhatIf(baseline, draft), [baseline, draft]);
  const delta = useMemo(() => deltaMonths(baseProj, scenProj), [baseProj, scenProj]);
  const changed = useMemo(() => diffInputs(baseline, draft), [baseline, draft]);
  const baseTarget = baseProj.targetCents;
  const pct = progressPct(baseline.portfolioCents, baseTarget);
  const feas = useMemo(
    () => assessFeasibility(scenProj.effectiveMonthlyInvestmentCents, initial.observedSurplusCents),
    [scenProj, initial.observedSurplusCents]
  );

  const targetDeltaPct =
    baseTarget > 0 ? Math.abs(scenProj.targetCents - baseTarget) / baseTarget : 0;
  const meaningful = delta !== null && (Math.abs(delta) >= 1 || targetDeltaPct >= 0.01);

  const sentence = useMemo(
    () =>
      actionSentence({
        baseline,
        scenario: draft,
        baselineArrival: baseProj.arrivalMonth,
        scenarioArrival: scenProj.arrivalMonth,
        delta,
      }),
    [baseline, draft, baseProj, scenProj, delta]
  );
  const deltaText = formatDelta(delta);
  const arrivalLabel = arrivalMonthLabel(scenProj.arrivalMonth);

  // ---------- analytics: intent and follow-through, never raw values ----------
  useEffect(() => {
    trackPlannerEvent("planner_viewed", { mode: initial.mode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!meaningful) return;
    const t = setTimeout(() => {
      trackPlannerEvent("scenario_changed", {
        levers: changed.map((c) => c.key).join("+") || "none",
        delta_bucket: deltaBucket(delta),
      });
    }, 800);
    return () => clearTimeout(t);
  }, [meaningful, changed, delta]);

  useEffect(() => {
    if (completedTimer.current) clearTimeout(completedTimer.current);
    if (!meaningful) return;
    completedTimer.current = setTimeout(() => {
      trackPlannerEvent("scenario_completed", { delta_bucket: deltaBucket(delta) });
    }, 3000);
    return () => {
      if (completedTimer.current) clearTimeout(completedTimer.current);
    };
  }, [meaningful, delta]);

  useEffect(() => {
    if ((feas.state === "note" || feas.state === "acknowledge") && !feasSeen.current) {
      feasSeen.current = true;
      trackPlannerEvent("feasibility_seen", {
        gap_bucket: gapBucket(
          feas.gapCents,
          initial.observedSurplusCents ?? 0
        ),
      });
    }
    if (feas.state === "ok" || feas.state === "unknown") feasSeen.current = false;
  }, [feas, initial.observedSurplusCents]);

  // ---------- polite announcements (debounced, not per frame) ----------
  useEffect(() => {
    if (announceTimer.current) clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => {
      setAnnounce(
        scenProj.reachable
          ? `Projected arrival ${arrivalLabel}, ${deltaText} than your saved plan.`
          : "Not on track under these assumptions."
      );
    }, 300);
    return () => {
      if (announceTimer.current) clearTimeout(announceTimer.current);
    };
  }, [arrivalLabel, deltaText, scenProj.reachable]);

  // ---------- draft persistence across navigation / sign-in round-trip ----------
  useEffect(() => {
    // A temporary handoff scenario is never persisted as a draft.
    if (tempScenario) return;
    if (mode === "saved" || setupStarted) {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        /* storage unavailable */
      }
    }
  }, [draft, mode, setupStarted, tempScenario]);

  // ---------- temporary handoff scenario (mount only) ----------
  useEffect(() => {
    const temp = loadTempScenario();
    if (!temp) return;
    const next = {
      ...initial.baseline,
      monthlyInvestmentCents: clampInput("monthlyInvestmentCents", temp.monthlyInvestmentCents),
    };
    if (validateInputs(next).length === 0) {
      setTempScenario(temp);
      setDraft(next);
      setSetupStarted(true);
      trackPlannerEvent("temp_scenario_applied", {});
    } else {
      try {
        localStorage.removeItem(TEMP_SCENARIO_KEY);
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const discardTempScenario = () => {
    try {
      localStorage.removeItem(TEMP_SCENARIO_KEY);
    } catch {
      /* ignore */
    }
    setTempScenario(null);
    setDraft(baseline);
  };

  useEffect(() => {
    if (initial.mode === "saved") {
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    const stored = loadStoredDraft();
    if (stored && !sameInputs(stored, initial.baseline)) setRestoreOffer(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const applyPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const next = { ...draft, ...preset.apply(baseline) };
    if (validateInputs(next).length === 0) setDraft(next);
    trackPlannerEvent("preset_selected", { preset: id });
    heroRef.current?.focus();
  };

  const reset = () => {
    setDraft(baseline);
    setShared(false);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  };

  // ---------- save flow ----------
  const openSave = () => {
    if (mode === "demo") {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        /* ignore */
      }
      router.push("/login?next=/number");
      return;
    }
    setSaveError(null);
    setConflict(null);
    setAckFeas(false);
    setConfirmOpen(true);
    setTimeout(() => confirmRef.current?.focus(), 50);
  };

  const doSave = async () => {
    if (feas.state === "acknowledge" && !ackFeas) return;
    setSaving(true);
    setSaveError(null);
    trackPlannerEvent("plan_save_started", {
      fields: changed.map((c) => c.key).join("+") || "none",
    });
    const resolved = resolveSaveInputs(baseline, draft);
    const clientProj = projectWhatIf(resolved, resolved);
    try {
      const res = await fetch("/api/fire/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: draft,
          baseline,
          settingsVersion,
          clientMonths: clientProj.months,
          calculationVersion: CALCULATION_VERSION,
          name: scenarioName.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (res.status === 409) {
        // Stale baseline — offer review instead of overwriting.
        const latest = json.latest as {
          annual_spending_cents: number;
          portfolio_cents: number;
          monthly_savings_cents: number;
          expected_return_pct: number;
          target_number_cents: number | null;
          target_mode: string;
          settings_version: number;
        } | null;
        if (latest) {
          setConflict({
            monthlySpendingCents: Math.round(latest.annual_spending_cents / 12),
            portfolioCents: latest.portfolio_cents,
            monthlyInvestmentCents: latest.monthly_savings_cents,
            annualReturnPct: Number(latest.expected_return_pct),
            targetMode: latest.target_mode === "custom" ? "custom" : "auto",
            customTargetCents: latest.target_number_cents,
            investDifference: false,
          });
        } else {
          setSaveError("Your saved plan changed elsewhere and could not be loaded. Try again.");
        }
        trackPlannerEvent("plan_save_failed", { reason: "conflict" });
        return;
      }
      if (!res.ok) {
        setSaveError(
          json.error === "calculation-mismatch"
            ? "The projection changed while saving — review and try again."
            : "Couldn't save — check your connection and retry."
        );
        trackPlannerEvent("plan_save_failed", { reason: String(json.error ?? "unknown") });
        return;
      }
      // Rebase: the scenario becomes the new baseline.
      const row = json.settings as {
        settings_version: number;
        updated_at: string;
      };
      setBaseline(resolved);
      setDraft(resolved);
      setSettingsVersion(row.settings_version);
      setSavedAt(row.updated_at);
      setMode("saved");
      setSetupStarted(true);
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      setConfirmOpen(false);
      setScenarioName("");
      trackPlannerEvent("plan_saved", { delta_bucket: deltaBucket(delta) });
      showToast(`Plan saved. ${arrivalMonthLabel(clientProj.arrivalMonth)} is now your baseline.`);
      setTimeout(() => confirmRef.current?.focus(), 50);
    } catch {
      setSaveError("Couldn't save — check your connection and retry.");
      trackPlannerEvent("plan_save_failed", { reason: "network" });
    } finally {
      setSaving(false);
    }
  };

  const reviewLatest = () => {
    if (!conflict) return;
    setBaseline(conflict);
    setDraft(conflict);
    setConflict(null);
    setConfirmOpen(false);
    showToast("Loaded the latest saved plan — review it before saving again.");
  };

  const share = async () => {
    const text = shareText({
      baseline,
      scenario: draft,
      baselineArrival: baseProj.arrivalMonth,
      scenarioArrival: scenProj.arrivalMonth,
      delta,
    });
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setShared(true);
    trackPlannerEvent("share_started", { format: "text" });
    showToast("Summary copied — no balances or target included.");
  };

  const baselineModeLabel =
    mode === "saved" ? "Your saved plan" : mode === "demo" ? "Demo baseline" : "Your new plan";

  return (
    <div className="space-y-6">
      {/* ---- preserved header ---- */}
      <div>
        <h1 className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
          The Number
        </h1>
        <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          Your finish line — the amount that makes work optional.
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <TrajectoryRing pct={pct} />
        <p className="tnum text-3xl font-bold text-[var(--text-hero-number)]">
          {formatUSDCompact(baseTarget)}
        </p>
        <p className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          25× your annual spending · 4% rule
        </p>
      </div>

      {/* ---- baseline card ---- */}
      {mode === "setup" && !setupStarted ? (
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <p className="text-[var(--type-body-size)] font-bold">Start with your Number.</p>
          <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            Add your spending, portfolio, and monthly investing so Coast can build a baseline.
          </p>
          <button
            type="button"
            onClick={() => {
              setSetupStarted(true);
              trackPlannerEvent("planner_viewed", { mode: "setup-started" });
            }}
            className="mt-4 min-h-[44px] w-full rounded-lg bg-[var(--accent-progress)] font-semibold text-white transition-transform active:scale-[0.99]"
          >
            Set up my Number
          </button>
        </div>
      ) : (
        <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
          <p className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
            {baselineModeLabel} · projected date
          </p>
          {baseProj.reachable ? (
            <>
              <p className="tnum mt-1 text-2xl font-bold text-[var(--text-hero-number)]">
                {arrivalMonthLabel(baseProj.arrivalMonth)}
              </p>
              <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                {baseProj.months} months away
              </p>
            </>
          ) : (
            <p className="mt-1 text-[var(--type-body-size)]">
              Not on track yet — even a small monthly increase moves the date.
            </p>
          )}
          {mode === "saved" && savedAt && (
            <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              Saved {new Date(savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </p>
          )}
          {mode === "demo" && (
            <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              Demo mode — sign in to save your own plan.
            </p>
          )}
        </div>
      )}

      {restoreOffer && (
        <div className="rounded-xl bg-[var(--surface-card)] p-5 elev-1" role="status">
          <p className="text-[var(--type-body-size)] font-semibold">Restore your unsaved scenario?</p>
          <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            You left a scenario unfinished before signing in.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(restoreOffer);
                setRestoreOffer(null);
                setSetupStarted(true);
                discardTempScenario();
              }}
              className="min-h-[44px] flex-1 rounded-lg bg-[var(--accent-progress)] font-semibold text-white"
            >
              Restore
            </button>
            <button
              type="button"
              onClick={() => {
                setRestoreOffer(null);
                try {
                  localStorage.removeItem(DRAFT_KEY);
                } catch {
                  /* ignore */
                }
              }}
              className="min-h-[44px] flex-1 rounded-lg bg-[var(--surface-secondary)] font-semibold"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* ---- temporary handoff scenario (Subscription Action Center) ---- */}
      {tempScenario && (
        <div className="rounded-xl bg-[var(--accent-progress-soft)] p-5 elev-1" role="status">
          <p className="text-[var(--type-body-size)] font-bold">
            Temporary scenario — {tempScenario.label}
          </p>
          {tempScenario.note && (
            <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              {tempScenario.note}
            </p>
          )}
          <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            This is not saved. Your plan is unchanged — use &ldquo;Save as plan&rdquo; below only
            if you want to keep it.
          </p>
          {(tempScenario.baselineVersion || tempScenario.calcVersion) && (
            <p className="mt-1 text-[var(--type-micro-size)] text-[var(--text-micro)]">
              {tempScenario.baselineVersion && `Baseline v${tempScenario.baselineVersion}`}
              {tempScenario.baselineVersion && tempScenario.calcVersion && " · "}
              {tempScenario.calcVersion && `Calc ${tempScenario.calcVersion}`}
            </p>
          )}
          <button
            type="button"
            onClick={discardTempScenario}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-lg bg-[var(--surface-card)] px-4 font-semibold"
          >
            Discard temporary scenario
          </button>
        </div>
      )}

      {/* ---- planner ---- */}
      {(mode !== "setup" || setupStarted) && (
        <section aria-label="What-if planner" className="space-y-6">
          <div>
            <h2
              ref={heroRef}
              tabIndex={-1}
              className="text-[var(--type-title-size)] font-bold outline-none"
            >
              What if you changed one thing?
            </h2>
            <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              An illustration, not a forecast — the assumptions behind it are listed below.
            </p>
          </div>

          {/* hero result */}
          <div className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
            {scenProj.reachable ? (
              <>
                <p className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
                  Projected arrival
                </p>
                <p className="tnum mt-1 text-2xl font-bold text-[var(--text-hero-number)]">
                  {arrivalLabel}
                </p>
                {delta !== null && delta !== 0 ? (
                  <p
                    className={`mt-2 inline-block rounded-full px-3 py-1 text-[var(--type-caption-size)] font-semibold ${
                      delta > 0
                        ? "bg-[var(--accent-progress-soft)] text-[var(--accent-progress)]"
                        : "bg-[var(--signal-warning-soft)] text-[var(--signal-warning)]"
                    }`}
                  >
                    <span aria-hidden="true">{delta > 0 ? "↑ " : "↓ "}</span>
                    {deltaText} than your {mode === "saved" ? "saved plan" : "baseline"}
                  </p>
                ) : (
                  <p className="mt-2 inline-block rounded-full bg-[var(--surface-secondary)] px-3 py-1 text-[var(--type-caption-size)] font-semibold text-[var(--text-secondary)]">
                    {deltaText}
                  </p>
                )}
                <p className="mt-3 text-[var(--type-body-size)]">{sentence}</p>
              </>
            ) : (
              <>
                <p className="text-[var(--type-body-size)] font-bold">
                  Not on track under these assumptions.
                </p>
                <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  At {formatUSD(scenProj.effectiveMonthlyInvestmentCents)}/mo invested and{" "}
                  {draft.annualReturnPct.toFixed(2)}% growth, the projection does not reach{" "}
                  {formatUSDCompact(scenProj.targetCents)} within the model horizon. Try raising
                  monthly investing first.
                </p>
              </>
            )}
            <span aria-live="polite" className="sr-only">
              {announce}
            </span>
          </div>

          {/* presets */}
          <div>
            <p className="mb-2 text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
              Try a preset
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p.id)}
                  className="min-h-[44px] shrink-0 rounded-full bg-[var(--surface-secondary)] px-4 text-[var(--type-caption-size)] font-semibold"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* controls */}
          <div className="rounded-xl bg-[var(--surface-card)] p-5 elev-1 space-y-6">
            <MoneyControl
              id="whatif-spending"
              label="Monthly spending"
              valueCents={draft.monthlySpendingCents}
              inputKey="monthlySpendingCents"
              format={(c) => `${formatUSD(c)}/mo`}
              onChange={(c) => setDraft((d) => ({ ...d, monthlySpendingCents: c }))}
            />
            <MoneyControl
              id="whatif-investing"
              label="Monthly investing"
              valueCents={draft.monthlyInvestmentCents}
              inputKey="monthlyInvestmentCents"
              format={(c) => `${formatUSD(c)}/mo`}
              onChange={(c) => setDraft((d) => ({ ...d, monthlyInvestmentCents: c }))}
            />
            <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={draft.investDifference}
                onChange={(e) => setDraft((d) => ({ ...d, investDifference: e.target.checked }))}
                className="mt-1 h-5 w-5 accent-[var(--accent-progress)]"
              />
              <span>
                <span className="text-[var(--type-body-size)] font-semibold">Invest the difference</span>
                <span className="block text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  When on, every dollar spent less each month is added to monthly investing.
                </span>
              </span>
            </label>

            <div>
              <p className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">Target amount</p>
              <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Target mode">
                {(["auto", "custom"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={draft.targetMode === m}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        targetMode: m,
                        customTargetCents:
                          m === "custom"
                            ? d.customTargetCents ?? resolveTargetCents({ ...d, targetMode: "auto" })
                            : d.customTargetCents,
                      }))
                    }
                    className={`min-h-[44px] flex-1 rounded-lg font-semibold ${
                      draft.targetMode === m
                        ? "bg-[var(--accent-progress)] text-white"
                        : "bg-[var(--surface-secondary)]"
                    }`}
                  >
                    {m === "auto" ? "25× spending" : "Custom"}
                  </button>
                ))}
              </div>
              {draft.targetMode === "custom" ? (
                <div className="mt-3 space-y-2">
                  <MoneyControl
                    id="whatif-target"
                    label="Custom target"
                    valueCents={draft.customTargetCents ?? resolveTargetCents({ ...draft, targetMode: "auto" })}
                    inputKey="customTargetCents"
                    format={(c) => formatUSD(c)}
                    onChange={(c) => setDraft((d) => ({ ...d, customTargetCents: c }))}
                  />
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, targetMode: "auto" }))}
                    className="min-h-[44px] text-[var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
                  >
                    Use 25× spending instead
                  </button>
                </div>
              ) : (
                <p className="tnum mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  {formatUSD(resolveTargetCents(draft))} — 25 times your annual spending
                </p>
              )}
            </div>

            <details className="rounded-lg bg-[var(--surface-secondary)] p-4">
              <summary className="min-h-[44px] cursor-pointer text-[var(--type-body-size)] font-semibold">
                Advanced assumptions
              </summary>
              <div className="mt-4 space-y-6">
                <div>
                  <div className="flex items-baseline justify-between">
                    <label htmlFor="whatif-return" className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                      Expected return <span className="italic">(assumption, not a behavior)</span>
                    </label>
                    <span className="tnum text-[var(--type-body-size)] font-semibold">
                      {draft.annualReturnPct.toFixed(2)}%
                    </span>
                  </div>
                  <input
                    id="whatif-return"
                    type="range"
                    className="whatif mt-1 w-full"
                    aria-valuetext={`${draft.annualReturnPct.toFixed(2)} percent`}
                    min={RANGES.annualReturnPct.min}
                    max={RANGES.annualReturnPct.max}
                    step={RANGES.annualReturnPct.step}
                    value={draft.annualReturnPct}
                    onChange={(e) => setDraft((d) => ({ ...d, annualReturnPct: Number(e.target.value) }))}
                  />
                  <p className="sr-only">Expected return: 0% to 12%, in steps of 0.25 percentage points.</p>
                </div>
                <MoneyControl
                  id="whatif-portfolio"
                  label="Current portfolio"
                  valueCents={draft.portfolioCents}
                  inputKey="portfolioCents"
                  format={(c) => formatUSD(c)}
                  onChange={(c) => setDraft((d) => ({ ...d, portfolioCents: c }))}
                />
              </div>
            </details>
          </div>

          {/* feasibility note */}
          {(feas.state === "note" || feas.state === "acknowledge") && (
            <div className="rounded-xl bg-[var(--surface-card)] p-5 elev-1" role="note">
              <p className="text-[var(--type-body-size)]">
                Heads up: {formatUSD(scenProj.effectiveMonthlyInvestmentCents)}/mo is more than your
                recent average surplus of {formatUSD(initial.observedSurplusCents ?? 0)}/mo — the
                projection assumes the full amount gets invested.
              </p>
            </div>
          )}

          {/* comparison */}
          {changed.length > 0 && (
            <div className="rounded-xl bg-[var(--surface-card)] p-5 elev-1">
              <p className="mb-3 text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
                Saved plan vs this scenario
              </p>
              <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 text-[var(--type-caption-size)]">
                <span className="sr-only">Assumption</span>
                <span className="font-semibold text-[var(--text-secondary)]">Saved plan</span>
                <span className="font-semibold text-[var(--text-secondary)]">This scenario</span>
                {changed.map((c) => (
                  <FragmentRow key={c.key} c={c} />
                ))}
              </div>
              <div className="mt-3 grid grid-cols-[1fr_1fr_1fr] gap-2 border-t border-[var(--border-subtle)] pt-3 text-[var(--type-caption-size)]">
                <span className="font-semibold">Arrival</span>
                <span className="tnum">{arrivalMonthLabel(baseProj.arrivalMonth)}</span>
                <span className="tnum font-semibold">{arrivalMonthLabel(scenProj.arrivalMonth)}</span>
              </div>
            </div>
          )}

          {/* actions — one filled primary */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={openSave}
              className="min-h-[48px] w-full rounded-lg bg-[var(--accent-progress)] font-semibold text-white transition-transform active:scale-[0.99]"
            >
              {mode === "demo" ? "Sign in to save plan" : "Save as plan"}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="min-h-[44px] flex-1 rounded-lg bg-[var(--surface-secondary)] font-semibold"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={share}
                disabled={!meaningful}
                className="min-h-[44px] flex-1 rounded-lg bg-[var(--surface-secondary)] font-semibold disabled:opacity-40"
              >
                {shared ? "Copied ✓" : "Share"}
              </button>
            </div>
          </div>

          {/* model note */}
          <details className="rounded-xl bg-[var(--surface-card)] p-5 elev-1">
            <summary className="min-h-[44px] cursor-pointer text-[var(--type-body-size)] font-semibold">
              How this projection works
            </summary>
            <div className="mt-2 space-y-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              <p>
                <strong>Illustration, not a guarantee.</strong> Coast compounds monthly using the
                assumptions shown. It does not include taxes, fees, or market volatility.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Compounding is monthly; contributions land at the end of each month.</li>
                <li>Target defaults to 25× annual spending (the 4% rule), or your custom target.</li>
                <li>Return is a nominal annual assumption you set — Coast never recommends one.</li>
                <li>The model stops at a 100-year horizon and reports month-level precision only.</li>
                <li>Calculation version {CALCULATION_VERSION}; projections are educational planning information, not individualized investment advice.</li>
              </ul>
            </div>
          </details>
        </section>
      )}

      {/* ---- save confirmation ---- */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="save-confirm-title">
          <div className="w-full max-w-md rounded-2xl bg-[var(--surface-card)] p-6 elev-1">
            {conflict ? (
              <>
                <h3 id="save-confirm-title" ref={confirmRef} tabIndex={-1} className="text-[var(--type-title-size)] font-bold outline-none">
                  Your saved plan changed
                </h3>
                <p className="mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  Someone — or another device — updated the plan after you started this scenario.
                  Review the latest before saving again.
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={reviewLatest}
                    className="min-h-[48px] flex-1 rounded-lg bg-[var(--accent-progress)] font-semibold text-white"
                  >
                    Review latest plan
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(false)}
                    className="min-h-[48px] flex-1 rounded-lg bg-[var(--surface-secondary)] font-semibold"
                  >
                    Keep editing
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 id="save-confirm-title" ref={confirmRef} tabIndex={-1} className="text-[var(--type-title-size)] font-bold outline-none">
                  Save as plan?
                </h3>
                <p className="mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                  This will update your saved plan{changed.length > 0 ? " — these fields change:" : "."}
                </p>
                {changed.length > 0 && (
                  <ul className="mt-3 space-y-2">
                    {changed.map((c) => (
                      <li key={c.key} className="flex items-baseline justify-between gap-2 text-[var(--type-caption-size)]">
                        <span className="font-semibold">{c.label}</span>
                        <span className="tnum text-[var(--text-secondary)]">
                          {c.baselineText} → <span className="font-semibold text-[var(--text-primary)]">{c.scenarioText}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-4">
                  <label htmlFor="scenario-name" className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
                    Scenario name <span className="italic">(optional)</span>
                  </label>
                  <input
                    id="scenario-name"
                    type="text"
                    value={scenarioName}
                    onChange={(e) => setScenarioName(e.target.value)}
                    placeholder="e.g. Aggressive 2027"
                    maxLength={60}
                    className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3"
                  />
                </div>
                {feas.state === "acknowledge" && (
                  <label className="mt-4 flex min-h-[44px] cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={ackFeas}
                      onChange={(e) => setAckFeas(e.target.checked)}
                      className="mt-1 h-5 w-5 accent-[var(--accent-progress)]"
                    />
                    <span className="text-[var(--type-caption-size)]">
                      I understand {formatUSD(scenProj.effectiveMonthlyInvestmentCents)}/mo is more
                      than my recent average surplus — the projection assumes the full amount gets
                      invested.
                    </span>
                  </label>
                )}
                {saveError && (
                  <p role="alert" className="mt-3 text-[var(--type-caption-size)] font-semibold text-red-600">
                    {saveError}
                  </p>
                )}
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={doSave}
                    disabled={saving || (feas.state === "acknowledge" && !ackFeas)}
                    className="min-h-[48px] flex-1 rounded-lg bg-[var(--accent-progress)] font-semibold text-white disabled:opacity-40"
                  >
                    {saving ? "Saving…" : "Save plan"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(false)}
                    className="min-h-[48px] flex-1 rounded-lg bg-[var(--surface-secondary)] font-semibold"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--text-primary)] px-4 py-2 text-[var(--type-caption-size)] font-semibold text-[var(--surface-card)] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function FragmentRow({ c }: { c: { key: string; label: string; baselineText: string; scenarioText: string } }) {
  return (
    <>
      <span className="font-semibold">{c.label}</span>
      <span className="tnum text-[var(--text-secondary)]">{c.baselineText}</span>
      <span className="tnum font-semibold">{c.scenarioText}</span>
    </>
  );
}

