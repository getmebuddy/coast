"use client";

/**
 * ConnectBank — the Plaid Link entry point.
 * Flow: POST /api/plaid/link-token → open Plaid Link → on success
 * POST /api/plaid/exchange (public_token → access token, stored encrypted)
 * → POST /api/plaid/sync (accounts + cursor-based transaction sync).
 * Uses the Plaid Link CDN script directly (no extra dependency).
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    Plaid?: any;
  }
}

const LINK_SCRIPT_URL = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

function loadLinkScript(): Promise<void> {
  if (typeof window !== "undefined" && window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${LINK_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Plaid Link failed to load.")));
      return;
    }
    const s = document.createElement("script");
    s.src = LINK_SCRIPT_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Plaid Link failed to load."));
    document.head.appendChild(s);
  });
}

type Status = "idle" | "starting" | "linking" | "connecting" | "syncing" | "done" | "error";

const LABELS: Record<Status, string> = {
  idle: "Connect your bank",
  starting: "Starting…",
  linking: "Choose your bank…",
  connecting: "Connecting…",
  syncing: "Pulling your transactions…",
  done: "Connected",
  error: "Try again",
};

export default function ConnectBank() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const router = useRouter();

  const connect = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setStatus("starting");
    try {
      const ltRes = await fetch("/api/plaid/link-token", { method: "POST" });
      if (ltRes.status === 401) {
        router.push("/login");
        busy.current = false;
        return;
      }
      if (!ltRes.ok) {
        const j = await ltRes.json().catch(() => ({}));
        throw new Error(j.error || "Bank connection isn't available right now.");
      }
      const { link_token } = await ltRes.json();
      if (!link_token) throw new Error("Bank connection isn't available right now.");

      await loadLinkScript();
      setStatus("linking");

      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (public_token: string, metadata: any) => {
          try {
            setStatus("connecting");
            const exRes = await fetch("/api/plaid/exchange", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                public_token,
                institution_name: metadata?.institution?.name,
              }),
            });
            if (!exRes.ok) {
              const j = await exRes.json().catch(() => ({}));
              const detail = j.stage ? ` [exchange:${exRes.status}/${j.stage}]` : ` [exchange:${exRes.status}]`;
              throw new Error(`Couldn't finish connecting — try again.${detail}`);
            }

            setStatus("syncing");
            const syRes = await fetch("/api/plaid/sync", { method: "POST" });
            if (!syRes.ok) throw new Error("Connected, but the first sync failed — try again.");

            setStatus("done");
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Something went wrong.");
            setStatus("error");
          } finally {
            busy.current = false;
          }
        },
        onExit: () => {
          setStatus("idle");
          busy.current = false;
        },
      });
      handler.open();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStatus("error");
      busy.current = false;
    }
  }, [router]);

  const disabled = status === "starting" || status === "linking" || status === "connecting" || status === "syncing";

  return (
    <div>
      <button
        type="button"
        onClick={connect}
        disabled={disabled}
        className="w-full rounded-xl bg-[var(--accent-progress)] px-4 py-3 text-[length:var(--type-body-size)] font-semibold text-white transition-opacity disabled:opacity-60"
      >
        {LABELS[status]}
      </button>
      {error && (
        <p className="mt-2 text-[length:var(--type-caption-size)] text-red-500">{error}</p>
      )}
      {status === "done" && (
        <p className="mt-2 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
          Your accounts are connected — transactions are syncing into your ledger.
        </p>
      )}
    </div>
  );
}
