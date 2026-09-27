"use client";

/**
 * MerchantIcon — merchant logo with a deterministic letter-avatar fallback.
 *
 * Logos come only from Plaid's `logo_url` (100x100 PNG) captured at sync
 * time; no scraping, no third-party logo APIs. When there is no logo (or it
 * fails to load), the merchant's initial renders on a name-derived color.
 */
import { useState } from "react";
import { avatarColorFor, avatarLetterFor } from "@/lib/merchant-avatar";

interface Props {
  /** Plaid logo_url (or null/undefined) — demo surfaces pass nothing. */
  logoUrl?: string | null;
  merchantName: string;
  size?: number;
}

export default function MerchantIcon({ logoUrl, merchantName, size = 32 }: Props) {
  const [failed, setFailed] = useState(false);

  if (logoUrl && !failed) {
    return (
      <img
        src={logoUrl}
        alt=""
        loading="lazy"
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        backgroundColor: avatarColorFor(merchantName),
        fontSize: Math.round(size * 0.45),
      }}
    >
      {avatarLetterFor(merchantName)}
    </span>
  );
}
