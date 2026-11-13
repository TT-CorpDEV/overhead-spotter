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
// The alert tag is "overhead-<ICAO hex>", which tells the app which aircraft to open.
const hexOf = (tag) => {
  const h = String(tag || "").replace("overhead-", "");
  return /^[0-9a-f]{6}$/.test(h) ? h : "";
};
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data.json();
  } catch (err) {}
  const hex = hexOf(d.tag);
  const cs = String(d.body || "").split("\n")[0].replace(/^[^:]*:\s*/, "").replace(/\s*\(.*$/, "");
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(d.title || "Overhead Spotter", { body: d.body || "", icon: "/icon.svg", badge: "/icon.svg", tag: d.tag || "overhead" }),
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ alert: { hex, cs } }))),
    ])
  );
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hex = hexOf(e.notification.tag);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          if (hex) c.postMessage({ open: hex });
          return c.focus();
        }
      }
      return self.clients.openWindow(hex ? "/#ac-" + hex : "/");
    })
  );
});
