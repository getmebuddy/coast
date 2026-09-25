import Link from "next/link";

/**
 * Persistent banner for signed-out demo surfaces. Every money-bearing
 * demo surface carries this; signed-in surfaces never render it.
 */
export default function DemoBanner() {
  return (
    <div
      role="note"
      aria-label="Demo data notice"
      className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-dashed border-[var(--accent-progress)] bg-[var(--surface-card)] px-4 py-3"
    >
      <p className="text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
        <span className="font-semibold text-[var(--text-primary)]">Demo data.</span>{" "}
        This preview uses sample numbers — sign in to see your real finances.
      </p>
      <Link
        href="/login"
        className="shrink-0 rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
      >
        Sign in
      </Link>
    </div>
  );
}
