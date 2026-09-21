import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          primary: "var(--surface-primary)",
          secondary: "var(--surface-secondary)",
          card: "var(--surface-card)",
          inset: "var(--surface-inset)",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          micro: "var(--text-micro)",
          hero: "var(--text-hero-number)",
        },
        accent: {
          progress: "var(--accent-progress)",
          soft: "var(--accent-progress-soft)",
          gold: "var(--accent-gold)",
        },
        signal: {
          warning: "var(--signal-warning)",
          warningsoft: "var(--signal-warning-soft)",
          critical: "var(--signal-critical)",
          criticalsoft: "var(--signal-critical-soft)",
        },
        border: { subtle: "var(--border-subtle)" },
      },
      fontSize: {
        hero: ["var(--type-hero-number-size)", { fontWeight: "var(--type-hero-number-weight)", lineHeight: "1" }],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
    },
  },
  plugins: [],
};

export default config;
