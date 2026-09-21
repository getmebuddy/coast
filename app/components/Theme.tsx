"use client";

import { useEffect, useState } from "react";

/** Theme provider: light/dark from day one, persisted. */
export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const saved = localStorage.getItem("coast-theme");
    const initial =
      saved === "dark" || saved === "light"
        ? saved
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("coast-theme", next);
  };

  return { theme, toggle };
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      className="rounded-full bg-[var(--surface-secondary)] px-3 py-1.5 text-[var(--type-caption-size)] text-[var(--text-secondary)] transition-transform active:scale-95"
    >
      {theme === "light" ? "◐ Dark" : "◑ Light"}
    </button>
  );
}
