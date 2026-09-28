"use client";

/**
 * /notifications — the notification archive. Same rows as the bell dropdown,
 * full-page: the mobile web panel and the desktop "View all" destination.
 * Signed-out visitors are sent to /login (fail closed).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { NotificationCenterItem } from "@/lib/notifications";
import { NotificationEmptyState, NotificationRow } from "../components/NotificationList";

type Status = "loading" | "ready" | "error";

export default function NotificationsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<NotificationCenterItem[]>([]);
  const [unread, setUnread] = useState(0);
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (res.status === 401) {
        router.replace("/login?next=/notifications");
        return;
      }
      const json = (await res.json()) as {
        ok: boolean;
        data?: { items: NotificationCenterItem[]; unread: number };
      };
      if (json.ok && json.data) {
        setItems(json.data.items);
        setUnread(json.data.unread);
        setStatus("ready");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const markAllRead = async () => {
    await fetch("/api/notifications/read", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
    setUnread(0);
    setItems((prev) =>
      prev.map((i) => ({ ...i, unread: false, read_at: new Date().toISOString() }))
    );
  };

  const openRow = async (item: NotificationCenterItem) => {
    if (item.unread) {
      await fetch("/api/notifications/read", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [item.id] }),
      }).catch(() => {});
    }
    router.push(item.href);
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[length:var(--type-title-size)] font-bold tracking-tight text-[var(--text-primary)]">
          Notifications
        </h1>
        {status === "ready" && unread > 0 && (
          <button
            onClick={markAllRead}
            className="text-[length:var(--type-caption-size)] font-semibold text-[var(--accent-progress)]"
          >
            Mark all read
          </button>
        )}
      </div>

      {status === "loading" && (
        <p className="py-10 text-center text-[length:var(--type-caption-size)] text-[var(--text-micro)]">
          Loading…
        </p>
      )}
      {status === "error" && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-6 py-10 text-center">
          <p className="font-bold text-[var(--text-primary)]">Couldn&apos;t load notifications</p>
          <button
            onClick={load}
            className="mt-3 rounded-lg bg-[var(--accent-progress)] px-4 py-2 text-sm font-semibold text-white"
          >
            Try again
          </button>
        </div>
      )}
      {status === "ready" &&
        (items.length === 0 ? (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
            <NotificationEmptyState />
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
            {items.map((item) => (
              <NotificationRow key={item.id} item={item} onOpen={openRow} />
            ))}
          </div>
        ))}

      <p className="mt-4 text-center text-[length:var(--type-caption-size)] text-[var(--text-micro)]">
        <Link href="/settings/notifications" className="font-semibold text-[var(--accent-progress)]">
          Notification settings
        </Link>{" "}
        — choose what Coast tells you about.
      </p>
    </div>
  );
}
