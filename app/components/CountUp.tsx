"use client";

import { useEffect, useRef, useState } from "react";
import { formatUSD } from "@/lib/fire";

/**
 * CountUp — the animated number primitive. This component IS the brand.
 * Numbers count/animate; they never jump.
 */
export default function CountUp({
  cents,
  duration = 900,
  className = "",
  prefix = "",
}: {
  cents: number;
  duration?: number;
  className?: string;
  prefix?: string;
}) {
  const [display, setDisplay] = useState(0);
  const raf = useRef<number>(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = cents;
    if (from === to) {
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutExpo: fast start, gentle settle — money in rises, money out settles
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) {
        raf.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [cents, duration]);

  return (
    <span className={`tnum ${className}`} aria-live="polite">
      {prefix}
      {formatUSD(display)}
    </span>
  );
}
