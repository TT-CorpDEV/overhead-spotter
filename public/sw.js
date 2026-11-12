// Keeps the app shell available offline and shows alert notifications.
const CACHE = "overhead-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  const keep = (res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(r, copy));
    return res;
  };
  const shell = u.origin === location.origin && ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"].includes(u.pathname);
  const lib = ["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(u.hostname);
  if (shell) e.respondWith(fetch(r).then(keep).catch(() => caches.match(r)));
  else if (lib) e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then(keep)));
});
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data.json();
  } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || "Overhead Spotter", { body: d.body || "", icon: "/icon.svg", badge: "/icon.svg", tag: d.tag || "overhead" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    })
  );
});
