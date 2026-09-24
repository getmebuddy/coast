"use client";

import { useEffect, useRef, useState } from "react";

/**
 * TrajectoryRing — the home hero. Custom SVG, no chart library.
 * Sweeps a few degrees every time new data lands. Living, not static.
 */
export default function TrajectoryRing({
  pct,
  size = 220,
  stroke = 14,
}: {
  pct: number; // 0–100
  size?: number;
  stroke?: number;
}) {
  const [sweep, setSweep] = useState(0);
  const raf = useRef<number>(0);
  const prev = useRef(0);

  useEffect(() => {
    const from = prev.current;
    const to = Math.min(100, Math.max(0, pct));
    const start = performance.now();
    const dur = 1200;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setSweep(from + (to - from) * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [pct]);

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = (sweep / 100) * c;

  return (
    <div className="relative inline-block" role="img" aria-label={`${pct.toFixed(1)} percent of the way to your number`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ring-track)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent-progress)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke var(--dur-standard) var(--ease-out)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tnum text-4xl font-bold text-[var(--text-hero-number)]">
          {sweep.toFixed(1)}%
        </span>
        <span className="text-[length:var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)] mt-1">
          of the way
        </span>
      </div>
    </div>
  );
}
