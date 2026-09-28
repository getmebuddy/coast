"use client";

/**
 * Notification settings — per-type email preferences plus a global pause.
 *
 * Absent key = default ON; turning a type back ON deletes its key. Phase 2/3
 * types are toggleable now and take effect when their phase ships. Signed-out
 * visitors get the standard labeled-demo sign-in prompt. Notify-only: these
 * prefs change what Coast tells you, never what it does.
 */
import { useEffect, useState } from "react";
import { NOTIFICATION_TYPES, type NotificationPhase, type NotificationType } from "@/lib/notifications";
import DemoBanner from "../../components/DemoBanner";

interface PrefsPayload {
  prefs: Record<string, boolean>;
  unsubscribed_all: boolean;
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  message?: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
  });
  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    throw new HttpError(
      res.status,
      json?.message ?? `Request failed (HTTP ${res.status}).`
    );
  }
  return json.data as T;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type PushState =
  | "checking"
  | "unsupported"
  | "not_configured"
  | "denied"
  | "off"
  | "on"
  | "working";

/**
 * Push notifications opt-in. Per-device: subscribing here enables pushes on
 * this browser only. Which kinds may push is still governed by the per-type
 * toggles below — and only the urgent kinds (charge tomorrow, price hikes,
 * fees, trials) ever push. The digest and recap stay email-only.
 */
function PushSection() {
  const [state, setState] = useState<PushState>("checking");
  const [error, setError] = useState<string | null>(null);

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

  const refresh = async () => {
    setError(null);
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setState("unsupported");
      return;
    }
    if (!publicKey) {
      setState("not_configured");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription().catch(() => null);
      if (sub) {
        setState("on");
      } else if (Notification.permission === "denied") {
        setState("denied");
      } else {
        setState("off");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check push status.");
      setState("off");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enable = async () => {
    setState("working");
    setError(null);
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const res = await fetch("/api/notifications/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        // Don't leave a dangling browser subscription the server doesn't know.
        await sub.unsubscribe().catch(() => {});
        throw new Error(`Server refused the subscription (HTTP ${res.status}).`);
      }
      setState("on");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not turn on push notifications."
      );
      setState("off");
    }
  };

  const disable = async () => {
    setState("working");
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription().catch(() => null);
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        await fetch("/api/notifications/push/subscribe", {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
      }
      setState("off");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not turn off push notifications."
      );
      setState("on");
    }
  };

  return (
    <section
      aria-label="Push notifications"
      className="rounded-xl bg-[var(--surface-card)] p-6 elev-1"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[length:var(--type-body-size)] font-semibold">
            Push notifications
          </p>
          <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            {state === "on"
              ? "On for this device — urgent alerts (charges, price hikes, fees, trials) will buzz your lock screen."
              : "Get urgent alerts on this device's lock screen. Only the urgent kinds ever push; the digest stays email."}
          </p>
        </div>
        {state === "on" ? (
          <button
            type="button"
            onClick={() => void disable()}
            disabled={false}
            className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg bg-[var(--surface-secondary)] px-4 font-semibold"
          >
            Turn off
          </button>
        ) : state === "off" ? (
          <button
            type="button"
            onClick={() => void enable()}
            className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg bg-[var(--accent-progress)] px-4 font-semibold text-white"
          >
            Turn on
          </button>
        ) : null}
      </div>

      {state === "working" && (
        <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Setting that up…
        </p>
      )}
      {state === "unsupported" && (
        <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          This browser doesn&apos;t support push notifications. Try Chrome, Edge,
          or Safari.
        </p>
      )}
      {state === "not_configured" && (
        <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Push isn&apos;t set up on the server yet — check back soon.
        </p>
      )}
      {state === "denied" && (
        <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          You blocked notifications for Coast in this browser. To re-enable: open
          your browser&apos;s site settings for this page, set Notifications to
          Allow, then come back and turn it on here.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[length:var(--type-caption-size)] text-[var(--signal-critical)]">
          {error}
        </p>
      )}
    </section>
  );
}

const PHASE_BADGES: { phase: NotificationPhase; badge: string; blurb: string | null }[] = [
  { phase: 1, badge: "Phase 1 — live", blurb: null },
  {
    phase: 2,
    badge: "Phase 2 — coming soon",
    blurb: "You can set your preference now; it takes effect when this ships.",
  },
  {
    phase: 3,
    badge: "Phase 3 — coming soon",
    blurb: "You can set your preference now; it takes effect when this ships.",
  },
];

function Switch({
  checked,
  onToggle,
  label,
  disabled,
}: {
  checked: boolean;
  onToggle: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-[var(--accent-progress)]" : "bg-[var(--ring-track)]"
      } disabled:opacity-50`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
          checked ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function TypeRow({
  type,
  enabled,
  onToggle,
  dimmed,
}: {
  type: NotificationType;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  dimmed: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-2 ${dimmed ? "opacity-60" : ""}`}
    >
      <div className="min-w-0">
        <p className="text-[length:var(--type-body-size)]">{type.name}</p>
        <p className="text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
          {type.description}
        </p>
      </div>
      <Switch checked={enabled} onToggle={onToggle} label={type.name} />
    </div>
  );
}

export default function NotificationSettingsPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [unsubscribedAll, setUnsubscribedAll] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const d = await api<PrefsPayload>("/api/notifications/prefs");
      setPrefs(d.prefs ?? {});
      setUnsubscribedAll(d.unsubscribed_all ?? false);
      setSignedIn(true);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        setSignedIn(false);
      } else {
        setLoadError(e instanceof Error ? e.message : "Could not load notification settings.");
      }
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: { prefs?: Record<string, boolean>; unsubscribed_all?: boolean }) => {
    setSaveError(null);
    try {
      const d = await api<PrefsPayload>("/api/notifications/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setPrefs(d.prefs ?? {});
      setUnsubscribedAll(d.unsubscribed_all ?? false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save your preferences.");
      throw e;
    }
  };

  /** Turning a type back ON deletes its key (absent = default ON). */
  const setTypeEnabled = async (id: string, enabled: boolean) => {
    const prev = prefs;
    const next: Record<string, boolean> = { ...prev };
    if (enabled) {
      delete next[id];
    } else {
      next[id] = false;
    }
    setPrefs(next);
    try {
      await save({ prefs: next });
    } catch {
      setPrefs(prev);
    }
  };

  const setPaused = async (paused: boolean) => {
    const prev = unsubscribedAll;
    setUnsubscribedAll(paused);
    try {
      await save({ unsubscribed_all: paused });
    } catch {
      setUnsubscribedAll(prev);
    }
  };

  if (signedIn === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Notification settings</h1>
        <DemoBanner />
        <p className="text-[length:var(--type-body-size)] text-[var(--text-secondary)]">
          Sign in to choose which emails Coast sends you.
        </p>
      </div>
    );
  }

  if (loadError || signedIn === null) {
    return (
      <div className="space-y-4">
        <h1 className="text-[length:var(--type-title-size)] font-bold">Notification settings</h1>
        {loadError ? (
          <div role="alert" className="rounded-xl bg-[var(--surface-card)] p-6 elev-1">
            <p className="text-[length:var(--type-body-size)] font-semibold">{loadError}</p>
            <button
              type="button"
              onClick={load}
              className="mt-4 inline-flex min-h-[44px] items-center rounded-lg bg-[var(--surface-secondary)] px-4 font-semibold"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="space-y-4" aria-label="Loading notification settings">
            <div className="h-24 rounded-xl bg-[var(--skeleton)]" />
            <div className="h-48 rounded-xl bg-[var(--skeleton)]" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[length:var(--type-title-size)] font-bold">Notification settings</h1>
        <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Decide which emails and push alerts Coast sends you. Coast only watches
          and tells — nothing here moves money or contacts anyone.
        </p>
      </div>

      <PushSection />

      {saveError && (
        <div role="alert" className="rounded-xl bg-[var(--signal-critical-soft)] p-4 elev-1">
          <p className="text-[length:var(--type-body-size)] font-semibold text-[var(--signal-critical)]">
            {saveError}
          </p>
        </div>
      )}

      {/* Global pause */}
      <section
        aria-label="Pause all notifications"
        className="rounded-xl bg-[var(--surface-card)] p-6 elev-1"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[length:var(--type-body-size)] font-semibold">Pause all Coast notifications</p>
            <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
              You can re-enable anytime here.
            </p>
          </div>
          <Switch
            checked={unsubscribedAll}
            onToggle={setPaused}
            label="Pause all Coast notifications"
          />
        </div>
        {unsubscribedAll && (
          <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            Paused — you won&apos;t get any Coast emails or push alerts while this is
            on, including types you&apos;ve left enabled below.
          </p>
        )}
      </section>

      {/* Per-type prefs, grouped by phase */}
      {PHASE_BADGES.map(({ phase, badge, blurb }) => {
        const types = NOTIFICATION_TYPES.filter((t) => t.phase === phase);
        if (types.length === 0) return null;
        return (
          <section
            key={phase}
            aria-label={badge}
            className="rounded-xl bg-[var(--surface-card)] p-6 elev-1"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[length:var(--type-title-size)] font-bold">
                {phase === 1 ? "Email types" : "On the way"}
              </h2>
              <span className="shrink-0 rounded-full bg-[var(--surface-secondary)] px-3 py-1 text-[length:var(--type-micro-size)] font-semibold text-[var(--text-secondary)]">
                {badge}
              </span>
            </div>
            {blurb && (
              <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                {blurb}
              </p>
            )}
            <div className="mt-2 divide-y divide-[var(--border-subtle)]">
              {types.map((t) => (
                <TypeRow
                  key={t.id}
                  type={t}
                  enabled={prefs[t.id] !== false}
                  onToggle={(next) => void setTypeEnabled(t.id, next)}
                  dimmed={unsubscribedAll}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
