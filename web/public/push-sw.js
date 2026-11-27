// Loaded by the service worker (vite.config.ts → workbox.importScripts): shows event reminders, and opens the
// event when one is tapped. Payload: { title, body, tag, url } (netlify/lib/reminders.mts).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "Winnipeg Events", {
    body: data.body || "",
    tag: data.tag,            // the same reminder twice replaces, rather than stacks
    icon: "/icons/icon-192.png",
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        await client.navigate(url);
        return client.focus();
      } catch {
        // not controlled by this worker yet: open a new window instead
      }
    }
    return self.clients.openWindow(url);
  })());
});
