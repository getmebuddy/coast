import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import TabBar from "./components/TabBar";
import { ThemeToggle } from "./components/Theme";
import NotificationBell from "./components/NotificationBell";

export const metadata: Metadata = {
  title: "Coast — your number, your trajectory",
  description: "Budgeting tells you where money went. Coast computes where you're going.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAF8" },
    { media: "(prefers-color-scheme: dark)", color: "#121210" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--surface-primary)]/90 backdrop-blur">
          <div className="mx-auto max-w-xl flex items-center justify-between px-4 py-3">
            <span className="text-[length:var(--type-title-size)] font-bold tracking-tight text-[var(--text-hero-number)]">
              Coast
            </span>
            <div className="flex items-center gap-2">
              <NotificationBell />
              <Link
                href="/settings"
                aria-label="Settings"
                className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] text-lg transition-transform active:scale-95"
              >
                <span aria-hidden>⚙</span>
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-xl px-4 pb-28 pt-6">{children}</main>
        <TabBar />
      </body>
    </html>
  );
}
