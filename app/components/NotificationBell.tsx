"use client";

/**
 * Notification bell for the shared app header. Signed-in users only:
 * a 401 from the unread-count endpoint means signed out, and the bell
 * renders nothing (fail closed).
 *
 * Desktop: clicking toggles the dropdown panel. Mobile web: clicking goes
 * straight to /notifications (the archive doubles as the panel).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { NotificationCenterItem } from "@/lib/notifications";
import { NotificationRow } from "./NotificationList";

interface ListResponse {
  ok: boolean;
  data?: { items: NotificationCenterItem[]; unread: number };
}

async function markRead(ids: string[] | "all"): Promise<void> {
  await fetch("/api/notifications/read", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ids === "all" ? { all: true } : { ids }),
  }).catch(() => {});
}

export default function NotificationBell() {
  const [unread, setUnread] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationCenterItem[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/unread-count", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (res.status === 401) {
        setUnread(null);
        return;
      }
      const json = (await res.json()) as { ok: boolean; data?: { unread: number } };
      if (json.ok && json.data) setUnread(json.data.unread);
    } catch {
      // Bell stays hidden on network failure — never block the header.
      setUnread(null);
    }
  }, []);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  // Close the dropdown on Escape or outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open ]);

  const loadItems = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const json = (await res.json()) as ListResponse;
      if (json.ok && json.data) {
        setItems(json.data.items);
        setUnread(json.data.unread);
      }
    } catch {
      setItems([]);
    }
  }, []);

  const handleBellClick = () => {
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    if (!desktop) {
      router.push("/notifications");
      return;
    }
    const next = !open;
    setOpen(next);
    if (next) loadItems();
  };

  const handleOpenRow = async (item: NotificationCenterItem) => {
    setOpen(false);
    if (item.unread) {
      await markRead([item.id]);
      setUnread((u) => (u == null ? u : Math.max(0, u - 1)));
    }
    router.push(item.href);
  };

  const handleMarkAllRead = async () => {
    await markRead("all");
    setUnread(0);
    setItems((prev) =>
      prev == null ? prev : prev.map((i) => ({ ...i, unread: false, read_at: new Date().toISOString() }))
    );
  };

  // Signed out (or failed check): render nothing — fail closed.
  if (unread === null) return null;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={handleBellClick}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] text-lg transition-transform active:scale-95"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--accent-progress)] px-1 text-[11px] font-bold text-white"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-12 z-50 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
            <span className="text-[length:var(--type-body-size)] font-bold text-[var(--text-primary)]">
              Notifications
            </span>
            {unread > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-[length:var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[420px] divide-y divide-[var(--border-subtle)] overflow-y-auto">
            {items === null ? (
              <p className="px-4 py-8 text-center text-[length:var(--type-caption-size)] text-[var(--text-micro)]">
                Loading…
              </p>
            ) : items.length === 0 ? (
              <div className="px-6 py-8 text-center">
                <p className="font-bold text-[var(--text-primary)]">You&apos;re all caught up</p>
                <p className="mt-1 text-[length:var(--type-caption-size)] text-[var(--text-secondary)]">
                  Coast stays quiet until there&apos;s something worth your attention.
                </p>
              </div>
            ) : (
              items.slice(0, 8).map((item) => (
                <NotificationRow key={item.id} item={item} onOpen={handleOpenRow} />
              ))
            )}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-4 py-3">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-[length:var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
            >
              View all
            </Link>
            <Link
              href="/settings/notifications"
              onClick={() => setOpen(false)}
              className="text-[length:var(--type-caption-size)] text-[var(--text-micro)]"
            >
              Notification settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
