/* TornScope push service worker.
 *
 * Deliberately MINIMAL: it handles Web Push + notification clicks only.
 * No offline caching — the app is a live dashboard and stale caches would
 * be worse than a network miss.
 */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "TornScope", body: event.data ? event.data.text() : "" };
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "TornScope";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    // Route used on click; keep the scope+bell mark for native rendering.
    data: { url: typeof payload.url === "string" ? payload.url : "/today" },
    tag: typeof payload.tag === "string" ? payload.tag : "tornscope",
    renotify: true,
    icon: "/icons/tornscope-notifications-192.png",
    badge: "/icons/tornscope-badge-monochrome.png",
    // Privacy-first: default notifications carry no sensitive detail, so
    // lock-screen visibility is fine.
    silent: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/today";
  const absolute = new URL(target, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        // Focus an existing TornScope tab and navigate it to the target.
        if (client.url.startsWith(self.location.origin)) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(absolute);
            } catch {
              await client.postMessage({ type: "navigate", url: absolute });
            }
          }
          return;
        }
      }
      await self.clients.openWindow(absolute);
    })()
  );
});
