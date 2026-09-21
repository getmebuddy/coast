"use client";

/**
 * ShareCard — renders a designed, number-first share card as custom SVG
 * (Coast design tokens, typographic, not a screenshot) and shares it via
 * the Web Share API on mobile, with a copy + PNG-download fallback on desktop.
 */
import { useRef, useState } from "react";
import type { Brief } from "@/lib/brief";
import { formatUSD } from "@/lib/fire";

function CardSVG({ brief, id }: { brief: Brief; id: string }) {
  const kept = brief.budgetLimitCents - brief.budgetSpentCents;
  const topFind = brief.priceChanges[0];
  const w = 640;
  const h = 400;
  return (
    <svg id={id} width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Coast monthly share card">
      <defs>
        <linearGradient id="coast-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#14342B" />
          <stop offset="1" stopColor="#1F7A5C" />
        </linearGradient>
      </defs>
      <rect width={w} height={h} rx="24" fill="url(#coast-bg)" />
      <text x="40" y="64" fill="#EAF6EF" fontSize="22" fontWeight="700" fontFamily="system-ui">Coast</text>
      <text x="40" y="92" fill="#B9D6C8" fontSize="14" fontFamily="system-ui">September close</text>

      <text x="40" y="160" fill="#B9D6C8" fontSize="13" letterSpacing="2" fontFamily="system-ui">KEPT</text>
      <text x="40" y="205" fill="#FFFFFF" fontSize="52" fontWeight="700" fontFamily="system-ui, tabular-nums">
        {formatUSD(Math.max(0, kept))}
      </text>
      <text x="40" y="232" fill="#B9D6C8" fontSize="14" fontFamily="system-ui">
        of {formatUSD(brief.budgetLimitCents)} budget
      </text>

      <text x="40" y="292" fill="#B9D6C8" fontSize="13" letterSpacing="2" fontFamily="system-ui">TO THE NUMBER</text>
      <text x="40" y="330" fill="#FFFFFF" fontSize="36" fontWeight="700" fontFamily="system-ui, tabular-nums">
        {brief.fireProgressPct.toFixed(1)}%
      </text>

      {topFind && (
        <text x="360" y="330" fill="#EAF6EF" fontSize="15" fontFamily="system-ui">
          {topFind.merchant} went up {topFind.prevAmountCents !== null ? formatUSD(topFind.prevAmountCents) : ""} → {formatUSD(topFind.amountCents)}
        </text>
      )}
      <text x="40" y={h - 32} fill="#9CC7B0" fontSize="13" fontFamily="system-ui">
        {brief.fireNudge}
      </text>
    </svg>
  );
}

export default function ShareCard({ brief }: { brief: Brief }) {
  const [state, setState] = useState<"idle" | "shared" | "copied" | "error">("idle");
  const svgWrap = useRef<HTMLDivElement>(null);

  const cardText = () => {
    const kept = brief.budgetLimitCents - brief.budgetSpentCents;
    const lines = [
      "My September with Coast:",
      `Kept ${formatUSD(Math.max(0, kept))} of ${formatUSD(brief.budgetLimitCents)}`,
      `${brief.fireProgressPct.toFixed(1)}% of the way to my number (${brief.fireArrival})`,
    ];
    if (brief.priceChanges[0]) {
      const p = brief.priceChanges[0];
      lines.push(`${p.merchant} raised its price — watching it.`);
    }
    return lines.join("\n");
  };

  const svgToPng = async (): Promise<Blob> => {
    const svg = svgWrap.current?.querySelector("svg");
    if (!svg) throw new Error("no svg");
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 800;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(img, 0, 0, 1280, 800);
    URL.revokeObjectURL(url);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png failed"))), "image/png")
    );
  };

  const share = async () => {
    setState("idle");
    try {
      const file = new File([await svgToPng()], "coast-september.png", { type: "image/png" });
      const text = cardText();
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "My Coast month", text });
        setState("shared");
        return;
      }
      if (navigator.share) {
        await navigator.share({ title: "My Coast month", text });
        setState("shared");
        return;
      }
      // Desktop fallback: copy text + download PNG
      await navigator.clipboard.writeText(text);
      const blob = await svgToPng();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "coast-september.png";
      a.click();
      setState("copied");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="rounded-xl bg-[var(--surface-card)] p-5 elev-1">
      <div ref={svgWrap} className="overflow-hidden rounded-lg">
        <CardSVG brief={brief} id="coast-share-svg" />
      </div>
      <button
        onClick={share}
        className="mt-4 w-full rounded-lg bg-[var(--accent-progress)] py-3 font-semibold text-white transition-transform active:scale-[0.99]"
      >
        Share my month
      </button>
      {state === "shared" && <p className="mt-2 text-center text-[var(--type-caption-size)] text-[var(--accent-progress)]">Shared.</p>}
      {state === "copied" && <p className="mt-2 text-center text-[var(--type-caption-size)] text-[var(--accent-progress)]">Copied + PNG downloaded.</p>}
      {state === "error" && (
        <p className="mt-2 text-center text-[var(--type-caption-size)] text-[var(--text-secondary)]">
          Sharing didn't work — your data is safe, try again.
        </p>
      )}
    </div>
  );
}
