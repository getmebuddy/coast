"use client";

/**
 * /settings — the settings hub. Minimal and real: every row leads to an
 * existing surface. Signed-out visitors get the sign-in prompt.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import pkg from "@/package.json";

const ROWS = [
  {
    href: "/settings/notifications",
    icon: "🔔",
    title: "Notifications",
    detail: "Email, push, quiet hours, and per-type preferences.",
  },
];

export default function SettingsHubPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setSignedIn(!!data.user))
      .catch(() => setSignedIn(false));
  }, []);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
    } finally {
      router.push("/login");
      router.refresh();
    }
  };

  return (
    <div>
      <h1 className="mb-4 text-[length:var(--type-title-size)] font-bold tracking-tight text-[var(--text-primary)]">
        Settings
      </h1>

      {signedIn === false && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-dashed border-[var(--accent-progress)] bg-[var(--surface-card)] px-4 py-3">
          <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
            Sign in to manage your Coast settings.
          </p>
          <Link
            href="/login?next=/settings"
            className="shrink-0 rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
          >
            Sign in
          </Link>
        </div>
      )}

      <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
        {ROWS.map((row) => (
          <Link
            key={row.href}
            href={row.href}
            className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--surface-secondary)]"
          >
            <span aria-hidden className="text-xl">{row.icon}</span>
            <span className="flex-1">
              <span className="block text-[length:var(--type-body-size)] font-semibold text-[var(--text-primary)]">
                {row.title}
              </span>
              <span className="block text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                {row.detail}
              </span>
            </span>
            <span aria-hidden className="text-[var(--text-micro)]">›</span>
          </Link>
        ))}
      </div>

      {signedIn === true && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
          <button
            onClick={signOut}
            disabled={signingOut}
            className="w-full px-4 py-3.5 text-left text-[length:var(--type-body-size)] font-semibold text-red-600 disabled:opacity-50"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}

      <p className="mt-6 text-center text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
        Coast v{pkg.version}
      </p>
    </div>
  );
}
