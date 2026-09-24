"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Home", icon: "⌂" },
  { href: "/brief", label: "Brief", icon: "☀" },
  { href: "/transactions", label: "Activity", icon: "⇄" },
  { href: "/subscriptions", label: "Subs", icon: "↻" },
  { href: "/budgets", label: "Budgets", icon: "▤" },
  { href: "/number", label: "Number", icon: "◎" },
];

/** Bottom tab bar — thumb-first. */
export default function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 inset-x-0 z-40 border-t border-[var(--border-subtle)] bg-[var(--surface-card)]/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto max-w-xl grid grid-cols-6">
        {TABS.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[var(--type-micro-size)] transition-colors ${
                active ? "text-[var(--accent-progress)] font-semibold" : "text-[var(--text-micro)]"
              }`}
            >
              <span aria-hidden className="text-xl leading-none">{t.icon}</span>
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
