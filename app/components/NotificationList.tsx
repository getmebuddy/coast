"use client";

/**
 * Shared notification-center row UI: unread tint + dot, letter avatar,
 * relative timestamp. Used by the header bell dropdown and the
 * /notifications archive page.
 */
import { avatarColorFor, avatarLetterFor } from "@/lib/merchant-avatar";
import type { NotificationCenterItem } from "@/lib/notifications";

/** "2h ago" / "Yesterday" / "Sep 20" — coarse, honest relative time. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function NotificationRow({
  item,
  onOpen,
}: {
  item: NotificationCenterItem;
  onOpen: (item: NotificationCenterItem) => void;
}) {
  const letter = avatarLetterFor(item.typeName);
  const color = avatarColorFor(item.typeName);
  return (
    <button
      onClick={() => onOpen(item)}
      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-secondary)] ${
        item.unread ? "bg-[var(--accent-progress-soft)]" : ""
      }`}
    >
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-bold text-white"
        style={{ backgroundColor: color }}
      >
        {letter}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={`truncate text-[length:var(--type-body-size)] ${
              item.unread ? "font-bold" : "font-semibold"
            } text-[var(--text-primary)]`}
          >
            {item.typeName}
          </span>
          {item.unread && (
            <span
              aria-label="Unread"
              className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent-progress)]"
            />
          )}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[length:var(--type-caption-size)] leading-snug text-[var(--text-secondary)]">
          {item.subject}
        </span>
        <span className="mt-0.5 block text-[length:var(--type-micro-size)] text-[var(--text-micro)]">
          {timeAgo(item.sent_at)}
        </span>
      </span>
    </button>
  );
}

export function NotificationEmptyState() {
  return (
    <div className="px-6 py-10 text-center">
      <div
        aria-hidden
        className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent-progress-soft)] text-2xl text-[var(--accent-progress)]"
      >
        ✓
      </div>
      <p className="text-[length:var(--type-title-size)] font-bold text-[var(--text-primary)]">
        You&apos;re all caught up
      </p>
      <p className="mt-1 text-[length:var(--type-caption-size)] leading-relaxed text-[var(--text-secondary)]">
        Coast stays quiet until there&apos;s something worth your attention.
      </p>
    </div>
  );
}
