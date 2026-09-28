/**
 * Coast push service worker. Served from /sw.js at app scope.
 *
 * Minimal and robust by design: on `push`, show a notification with the
 * title/body/deep-link from the payload; on `notificationclick`, open or
 * focus the deep link. No analytics ping on show — same no-tracking
 * philosophy as the email templates (clicks are tracked server-side when
 * the user taps through to the app).
 *
 * Payload shape (JSON): { title, body, url, tag }.
 * `url` must be an app-relative path; anything else falls back to /brief.
 */

function safeUrl(u) {
  if (typeof u !== "string" || u.startsWith("//")) return "/brief";
  if (/^\/[^\s\\]*$/.test(u) && !u.includes("://") && !u.includes("..")) {
    return u;
  }
  return "/brief";
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 80) : "Coast";
  const body = typeof data.body === "string" ? data.body.slice(0, 160) : "";
  const url = safeUrl(data.url);
  const tag = typeof data.tag === "string" ? data.tag.slice(0, 64) : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body || undefined,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag,
      // Re-notify on repeat tags so a re-sent alert still buzzes.
      renotify: true,
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  const absolute = new URL(url, self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const w of windows) {
          try {
            if (new URL(w.url).origin === self.location.origin) {
              return w.navigate(absolute).then((c) => c.focus());
            }
          } catch {
            // ignore malformed client URLs
          }
        }
        return self.clients.openWindow(absolute);
      })
  );
});
