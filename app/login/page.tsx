"use client";

/** Sign in — email + password, with magic-link fallback. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { magicLinkRedirectTo } from "@/lib/auth";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [status, setStatus] = useState<string | null>(null);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    const supabase = createClient();
    try {
      if (mode === "magic") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: magicLinkRedirectTo(window.location.origin) },
        });
        if (error) throw error;
        setStatus("Check your email for the sign-in link.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/");
        router.refresh();
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Something went wrong — try again.");
    }
  };

  return (
    <div className="mx-auto max-w-sm pt-10">
      <h1 className="text-[var(--type-title-size)] font-bold">Welcome to Coast</h1>
      <p className="mt-1 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
        Sign in to see your real numbers. Demo mode works without an account.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <div>
          <label htmlFor="email" className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2"
          />
        </div>
        {mode === "password" && (
          <div>
            <label htmlFor="password" className="text-[var(--type-caption-size)] text-[var(--text-secondary)]">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2"
            />
          </div>
        )}
        <button
          type="submit"
          className="w-full rounded-lg bg-[var(--accent-progress)] py-3 font-semibold text-white transition-transform active:scale-[0.99]"
        >
          {mode === "magic" ? "Send magic link" : "Sign in"}
        </button>
      </form>
      <button
        onClick={() => setMode(mode === "magic" ? "password" : "magic")}
        className="mt-3 w-full text-center text-[var(--type-caption-size)] text-[var(--accent-progress)] font-semibold"
      >
        {mode === "magic" ? "Use password instead" : "Email me a magic link instead"}
      </button>
      {status && (
        <p role="status" className="mt-3 text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          {status}
        </p>
      )}
      {typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("error") === "link" && (
          <p role="alert" className="mt-3 text-[var(--type-caption-size)] font-semibold text-red-600">
            That sign-in link didn&apos;t work — request a fresh one below.
          </p>
        )}
    </div>
  );
}
